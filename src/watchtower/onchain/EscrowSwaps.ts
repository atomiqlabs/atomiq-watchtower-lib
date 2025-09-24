import {SavedSwap} from "../SavedSwap";
import {PrunedTxMap} from "./PrunedTxMap";
import {
    BtcStoredHeader, ChainEvent, ChainSwapType,
    ChainType,
    InitializeEvent,
    IStorageManager,
    SwapDataVerificationError,
    SwapEvent, TransactionRevertedError
} from "@atomiqlabs/base";
import {BtcRelayWatchtower, WatchtowerClaimTxType, WatchtowerEscrowClaimData} from "./BtcRelayWatchtower";
import {getLogger} from "../../utils/Utils";

const logger = getLogger("EscrowSwaps: ")

export class EscrowSwaps<T extends ChainType, B extends BtcStoredHeader<any>> {

    readonly txoHashMap: Map<string, SavedSwap<T>[]> = new Map<string, SavedSwap<T>[]>();
    readonly escrowHashMap: Map<string, SavedSwap<T>> = new Map<string, SavedSwap<T>>();

    readonly storage: IStorageManager<SavedSwap<T>>;

    readonly swapContract: T["Contract"];

    readonly root: BtcRelayWatchtower<T, B>;

    readonly shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>;

    constructor(
        root: BtcRelayWatchtower<T, B>,
        storage: IStorageManager<SavedSwap<T>>,
        swapContract: T["Contract"],
        shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>
    ) {
        this.root = root;
        this.storage = storage;
        this.swapContract = swapContract;
        this.shouldClaimCbk = shouldClaimCbk;

        this.root.swapEvents.registerListener(async (obj: ChainEvent<T["Data"]>[]) => {
            for(let event of obj) {
                if(!(event instanceof SwapEvent)) continue;
                if(event instanceof InitializeEvent) {
                    if(event.swapType!==ChainSwapType.CHAIN) continue;

                    const swapData = await event.swapData();
                    if(swapData.hasSuccessAction()) continue;
                    if(swapData.getTxoHashHint()==null || swapData.getConfirmationsHint()==null) {
                        logger.warn("chainsEventListener: Skipping escrow "+swapData.getEscrowHash()+" due to missing txoHash & confirmations hint");
                        continue;
                    }

                    const escrowHash = swapData.getEscrowHash();
                    if(this.storage.data[escrowHash]!=null) {
                        logger.info(`chainsEventListener: Skipped adding new swap to watchlist, already there! escrowHash: ${escrowHash}`);
                        continue;
                    }

                    const txoHash: Buffer = Buffer.from(swapData.getTxoHashHint(), "hex");
                    const txoHashHex = txoHash.toString("hex");

                    const savedSwap: SavedSwap<T> = new SavedSwap<T>(txoHash, swapData);
                    logger.info("chainsEventListener: Adding new swap to watchlist: ", savedSwap);
                    await this.save(savedSwap);

                    //Check with pruned tx map
                    const data = this.root.prunedTxoMap.getTxoObject(txoHashHex);
                    if(data!=null) {
                        const requiredBlockHeight = data.height+savedSwap.swapData.getConfirmationsHint()-1;
                        if(requiredBlockHeight<=this.root.prunedTxoMap.tipHeight) {
                            //Claimable
                            const isCommited = await this.swapContract.isCommited(swapData);
                            if(isCommited) {
                                await this.claim(txoHash, savedSwap, data.txId, data.vout, data.height);
                            }
                        }
                    }
                } else {
                    const success = await this.removeByEscrowHash(event.escrowHash);
                    if(success) {
                        logger.info("chainsEventListener: Removed swap from watchlist: ", event.escrowHash);
                    }
                }
            }
            return true;
        });
    }

    async init() {
        await this.load();
    }

    private async load() {
        await this.storage.init();
        const loadedData = await this.storage.loadData(SavedSwap);
        loadedData.forEach(swap => {
            const txoHash = swap.txoHash.toString("hex");
            let arr = this.txoHashMap.get(txoHash);
            if(arr==null) this.txoHashMap.set(txoHash, arr = []);
            arr.push(swap);
            this.escrowHashMap.set(swap.swapData.getEscrowHash(), swap);
        });
    }

    private async save(swap: SavedSwap<T>) {
        const txoHash = swap.txoHash.toString("hex");
        const escrowHash = swap.swapData.getEscrowHash();
        let arr = this.txoHashMap.get(txoHash);
        if(arr==null) this.txoHashMap.set(txoHash, arr = []);
        if(!arr.includes(swap)) arr.push(swap);
        this.escrowHashMap.set(escrowHash, swap);
        await this.storage.saveData(escrowHash, swap);
    }

    private remove(savedSwap: SavedSwap<T>): Promise<boolean> {
        return this.removeByEscrowHash(savedSwap.swapData.getEscrowHash());
    }

    private async removeByEscrowHash(escrowHash: string): Promise<boolean> {
        const swap = this.escrowHashMap.get(escrowHash);
        if(swap==null) return false;

        const txoHash = swap.txoHash.toString("hex");
        const arr = this.txoHashMap.get(txoHash);
        if(arr!=null) {
            const index = arr.indexOf(swap);
            if(index!==-1) arr.splice(index, 1);
            if(arr.length===0) this.txoHashMap.delete(txoHash);
        }
        this.escrowHashMap.delete(escrowHash);
        await this.storage.removeData(escrowHash);

        return true;
    }

    private async createClaimTxs(
        txoHash: Buffer,
        swap: SavedSwap<T>,
        txId: string,
        voutN: number,
        blockheight: number,
        computedCommitedHeaders?: {
            [height: number]: B
        },
        initAta?: boolean,
        feeRate?: any
    ): Promise<T["TX"][] | null> {
        const isCommited = await this.swapContract.isCommited(swap.swapData);

        if(!isCommited) {
            logger.debug("createClaimTxs(): Not claiming swap txoHash: "+txoHash.toString("hex")+" due to it not being commited anymore!");
            return null;
        }

        logger.info("createClaimTxs(): Claim swap txns: "+swap.swapData.getEscrowHash()+" UTXO: ", txId+":"+voutN+"@"+blockheight);

        const tx = await this.root.bitcoinRpc.getTransaction(txId);

        //Re-check txoHash
        const vout = tx.outs[voutN];
        const computedTxoHash = PrunedTxMap.toTxoHash(vout.value, vout.scriptPubKey.hex);

        if(!txoHash.equals(computedTxoHash)) throw new Error("TXO hash mismatch");

        const requiredConfirmations = swap.swapData.getConfirmationsHint();
        if(tx.confirmations<requiredConfirmations) throw new Error("Not enough confirmations yet");

        let storedHeader: B = null;
        if(computedCommitedHeaders!=null) {
            storedHeader = computedCommitedHeaders[blockheight];
        }

        let txs;
        try {
            txs = await this.swapContract.txsClaimWithTxData(
                this.root.signer, swap.swapData, {...tx, height: blockheight}, requiredConfirmations, voutN,
                storedHeader, null, initAta==null ? false : initAta, feeRate
            );
        } catch (e) {
            if(e instanceof SwapDataVerificationError) {
                logger.warn("createClaimTxs(): Not claiming swap txoHash: "+txoHash.toString("hex")+" due to SwapDataVerificationError!", e);
                return null;
            }
            throw e;
        }
        return txs;

    }

    private async claim(txoHash: Buffer, swap: SavedSwap<T>, txId: string, vout: number, blockheight: number): Promise<boolean> {
        logger.info("claim(): Claim swap: "+swap.swapData.getEscrowHash()+" UTXO: ", txId+":"+vout+"@"+blockheight);

        try {
            const unlock = swap.lock(120);

            if(unlock==null) return false;

            let feeData;
            if(this.shouldClaimCbk!=null) {
                feeData = await this.shouldClaimCbk(swap);
                if(feeData==null) {
                    logger.debug("claim(): Not claiming swap with txoHash: "+txoHash.toString("hex")+" due to negative response from shouldClaimCbk() callback!");
                    return false;
                }
                logger.debug("claim(): Claiming swap with txoHash: "+txoHash+" initAta: "+feeData.initAta+" feeRate: "+feeData.feeRate);
            } else {
                logger.debug("claim(): Claiming swap with txoHash: "+txoHash);
            }

            try {
                const tx = await this.root.bitcoinRpc.getTransaction(txId);
                const requiredConfirmations = swap.swapData.getConfirmationsHint();
                await this.swapContract.claimWithTxData(
                    this.root.signer, swap.swapData, {...tx, height: blockheight}, requiredConfirmations, vout,
                    null, null, feeData?.initAta==null ? false : feeData.initAta,
                    {
                        waitForConfirmation: true,
                        feeRate: feeData?.feeRate
                    }
                );
            } catch (e) {
                if(e instanceof SwapDataVerificationError) {
                    await this.remove(swap);
                    return false;
                }
                if(e instanceof TransactionRevertedError) {
                    logger.error(`claim(): Marking claim attempt failed (tx reverted) for swap with txoHash: ${txoHash}!`, e);
                    swap.claimAttemptFailed = true;
                    await this.save(swap);
                    return false;
                }
                return false;
            }

            logger.info("claim(): Claim swap: "+swap.swapData.getEscrowHash()+" success!");

            await this.remove(swap);

            unlock();

            return true;
        } catch (e) {
            logger.error("claim(): Error when claiming swap: "+swap.swapData.getEscrowHash(), e);
            return false;
        }

    }

    private async tryGetClaimTxs(
        txoHash: string,
        data: {txId: string, vout: number, height: number},
        tipHeight: number,
        computedHeaderMap?: {[blockheight: number]: B}
    ) {
        const savedSwaps = this.txoHashMap.get(txoHash);

        const result: WatchtowerClaimTxType<T>[] = [];
        for(let savedSwap of savedSwaps) {
            if(savedSwap.claimAttemptFailed) continue;

            const requiredBlockHeight = data.height+savedSwap.swapData.getConfirmationsHint()-1;
            if(requiredBlockHeight<=tipHeight) {
                logger.debug("tryGetClaimTxs(): Getting claim txs for txoHash: "+txoHash+" txId: "+data.txId+" vout: "+data.vout);
                //Claimable
                try {
                    const unlock = savedSwap.lock(120);
                    if(unlock==null) continue;

                    //Check claimer's bounty and create ATA if the claimer bounty covers the costs of it!

                    let claimTxs: T["TX"][];
                    if(this.shouldClaimCbk!=null) {
                        const feeData = await this.shouldClaimCbk(savedSwap);
                        if(feeData==null) {
                            logger.debug("tryGetClaimTxs(): Not claiming swap with txoHash: "+txoHash+" due to negative response from shouldClaimCbk() callback!");
                            continue;
                        }
                        logger.debug("tryGetClaimTxs(): Claiming swap with txoHash: "+txoHash+" initAta: "+feeData.initAta+" feeRate: "+feeData.feeRate);
                        claimTxs = await this.createClaimTxs(
                            Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height,
                            computedHeaderMap, feeData.initAta, feeData.feeRate
                        );
                    } else {
                        logger.debug("tryGetClaimTxs(): Claiming swap with txoHash: "+txoHash);
                        claimTxs = await this.createClaimTxs(
                            Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height,
                            computedHeaderMap
                        );
                    }

                    if(claimTxs==null)  {
                        await this.remove(savedSwap);
                    } else {
                        result.push({
                            getTxs: async (height?: number, checkClaimable?: boolean) => {
                                if(height!=null && height < requiredBlockHeight) return null;
                                if(checkClaimable && !(await this.swapContract.isCommited(savedSwap.swapData))) return null;
                                return claimTxs;
                            },
                            data: {
                                vout: data.vout,
                                swapData: savedSwap.swapData,
                                txId: data.txId,
                                blockheight: data.height,
                                maturedAt: requiredBlockHeight,
                            }
                        });
                    }
                } catch (e) {
                    logger.error("tryGetClaimTxs(): Error getting claim txs for txoHash: "+txoHash+" txId: "+data.txId+" vout: "+data.vout, e);
                }
            } else {
                logger.warn("tryGetClaimTxs(): Cannot get claim txns yet, txoHash: "+txoHash+" requiredBlockheight: "+requiredBlockHeight+" tipHeight: "+tipHeight);
                continue;
            }
        }

        return result;
    }

    async markEscrowClaimReverted(escrowHash: string): Promise<boolean> {
        const savedSwap = this.escrowHashMap.get(escrowHash);
        if(savedSwap==null) return false;
        savedSwap.claimAttemptFailed = true;
        await this.save(savedSwap);
        return true;
    }

    async getClaimTxs(
        foundTxos?: Map<string, {txId: string, vout: number, height: number}>,
        computedHeaderMap?: {[blockheight: number]: B}
    ): Promise<{
        [escrowHash: string]: WatchtowerClaimTxType<T>
    }> {
        const tipHeight = this.root.prunedTxoMap.tipHeight;

        const txs: {
            [escrowHash: string]: WatchtowerClaimTxType<T>
        } = {};

        //Check txoHashes that got required confirmations in the to-be-synchronized blocks,
        // but they might be already pruned if we only checked after
        if(foundTxos!=null) {
            logger.debug("getClaimTxs(): Checking found txos: ", foundTxos);
            for(let entry of foundTxos.entries()) {
                const txoHash = entry[0];
                const data = entry[1];
                const claimTxDataArray = await this.tryGetClaimTxs(txoHash, data, tipHeight, computedHeaderMap);
                claimTxDataArray.forEach(value => {
                    const data = value.data as WatchtowerEscrowClaimData<T>;
                    const escrowHash = data.swapData.getEscrowHash();
                    txs[escrowHash] = value;
                });
            }
        }

        //Check all the txs, if they are already confirmed in these blocks
        logger.debug("getClaimTxs(): Checking all saved swaps...");
        for(let txoHash of this.txoHashMap.keys()) {
            if(foundTxos!=null && foundTxos.has(txoHash)) continue;
            const data = this.root.prunedTxoMap.getTxoObject(txoHash);
            if(data==null) continue;

            const claimTxDataArray = await this.tryGetClaimTxs(txoHash, data, tipHeight, computedHeaderMap);
            claimTxDataArray.forEach(value => {
                const data = value.data as WatchtowerEscrowClaimData<T>;
                const escrowHash = data.swapData.getEscrowHash();
                txs[escrowHash] = value;
            });
        }

        return txs;
    }

}

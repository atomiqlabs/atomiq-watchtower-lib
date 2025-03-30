import {SavedSwap} from "./SavedSwap";
import {PrunedTxMap} from "./PrunedTxMap";
import {
    BtcStoredHeader, ChainEvent, ChainSwapType,
    ChainType,
    InitializeEvent,
    IStorageManager,
    SwapDataVerificationError,
    SwapEvent
} from "@atomiqlabs/base";
import {Watchtower, WatchtowerClaimTxType} from "./Watchtower";

export class EscrowSwaps<T extends ChainType, B extends BtcStoredHeader<any>> {

    readonly txoHashMap: Map<string, SavedSwap<T>> = new Map<string, SavedSwap<T>>();
    readonly escrowHashMap: Map<string, SavedSwap<T>> = new Map<string, SavedSwap<T>>();

    readonly storage: IStorageManager<SavedSwap<T>>;

    readonly swapContract: T["Contract"];

    readonly root: Watchtower<T, B>;

    readonly shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>;

    constructor(
        root: Watchtower<T, B>,
        storage: IStorageManager<SavedSwap<T>>,
        swapContract: T["Contract"],
        shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>
    ) {
        this.root = root;
        this.storage = storage;
        this.swapContract = swapContract;
        this.shouldClaimCbk = shouldClaimCbk;
    }

    async init() {
        await this.load();

        this.root.swapEvents.registerListener(async (obj: ChainEvent<T["Data"]>[]) => {
            for(let event of obj) {
                if(!(event instanceof SwapEvent)) continue;
                if(event instanceof InitializeEvent) {
                    if(event.swapType!==ChainSwapType.CHAIN) continue;

                    const swapData = await event.swapData();
                    if(swapData.getTxoHashHint()==null || swapData.getConfirmationsHint()==null) {
                        console.log("Watchtower: chainsEventListener: Skipping escrow "+swapData.getEscrowHash()+" due to missing txoHash & confirmations hint");
                        continue;
                    }

                    const txoHash: Buffer = Buffer.from(swapData.getTxoHashHint(), "hex");
                    const txoHashHex = txoHash.toString("hex");

                    const savedSwap: SavedSwap<T> = new SavedSwap<T>(txoHash, swapData);

                    console.log("Watchtower: chainsEventListener: Adding new swap to watchlist: ", savedSwap);

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
                        console.log("Watchtower: chainsEventListener: Removed swap from watchlist: ", event.escrowHash);
                    }
                }
            }
            return true;
        });
    }

    private async load() {
        await this.storage.init();
        const loadedData = await this.storage.loadData(SavedSwap);
        loadedData.forEach(swap => {
            this.txoHashMap.set(swap.txoHash.toString("hex"), swap);
            this.escrowHashMap.set(swap.swapData.getEscrowHash(), swap);
        });
    }

    private async save(swap: SavedSwap<T>) {
        this.txoHashMap.set(swap.txoHash.toString("hex"), swap);
        this.escrowHashMap.set(swap.swapData.getEscrowHash(), swap);
        await this.storage.saveData(swap.txoHash.toString("hex"), swap);
    }

    private async remove(txoHash: Buffer): Promise<boolean> {
        const swap = this.txoHashMap.get(txoHash.toString("hex"));
        if(swap==null) return false;

        this.txoHashMap.delete(swap.txoHash.toString("hex"));
        this.escrowHashMap.delete(swap.swapData.getEscrowHash());
        await this.storage.removeData(swap.txoHash.toString("hex"));

        return true;
    }

    private async removeByEscrowHash(escrowHash: string): Promise<boolean> {
        const swap = this.escrowHashMap.get(escrowHash);
        if(swap==null) return false;

        this.txoHashMap.delete(swap.txoHash.toString("hex"));
        this.escrowHashMap.delete(swap.swapData.getEscrowHash());
        await this.storage.removeData(swap.txoHash.toString("hex"));

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
            console.log("Watchtower: createClaimTxs(): Not claiming swap txoHash: "+txoHash.toString("hex")+" due to it not being commited anymore!");
            return null;
        }

        console.log("Watchtower: createClaimTxs(): Claim swap txns: "+swap.swapData.getEscrowHash()+" UTXO: ", txId+":"+voutN+"@"+blockheight);

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
                console.log("Watchtower: createClaimTxs(): Not claiming swap txoHash: "+txoHash.toString("hex")+" due to SwapDataVerificationError!");
                console.error(e);
                return null;
            }
            throw e;
        }
        return txs;

    }

    private async claim(txoHash: Buffer, swap: SavedSwap<T>, txId: string, vout: number, blockheight: number): Promise<boolean> {
        console.log("Watchtower: claim(): Claim swap: "+swap.swapData.getEscrowHash()+" UTXO: ", txId+":"+vout+"@"+blockheight);

        try {
            const unlock = swap.lock(120);

            if(unlock==null) return false;

            let feeData;
            if(this.shouldClaimCbk!=null) {
                feeData = await this.shouldClaimCbk(swap);
                if(feeData==null) {
                    console.log("Watchtower: claim(): Not claiming swap with txoHash: "+txoHash.toString("hex")+" due to negative response from shouldClaimCbk() callback!");
                    return false;
                }
                console.log("Watchtower: claim(): Claiming swap with txoHash: "+txoHash+" initAta: "+feeData.initAta+" feeRate: "+feeData.feeRate);
            } else {
                console.log("Watchtower: claim(): Claiming swap with txoHash: "+txoHash);
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
                    await this.remove(swap.txoHash);
                    return false;
                }
                return false;
            }

            console.log("Watchtower: claim(): Claim swap: "+swap.swapData.getEscrowHash()+" success!");

            await this.remove(txoHash);

            unlock();

            return true;
        } catch (e) {
            console.error(e);
            return false;
        }

    }

    private async tryGetClaimTxs(
        txoHash: string,
        data: {txId: string, vout: number, height: number},
        tipHeight: number,
        computedHeaderMap?: {[blockheight: number]: B}
    ): Promise<WatchtowerClaimTxType<T>> {
        const savedSwap = this.txoHashMap.get(txoHash);
        const requiredBlockHeight = data.height+savedSwap.swapData.getConfirmationsHint()-1;
        if(requiredBlockHeight<=tipHeight) {
            console.log("EscrowSwaps: tryGetClaimTxs(): Getting claim txs for txoHash: "+txoHash+" txId: "+data.txId+" vout: "+data.vout);
            //Claimable
            try {
                const unlock = savedSwap.lock(120);
                if(unlock==null) return;

                //Check claimer's bounty and create ATA if the claimer bounty covers the costs of it!

                let claimTxs: T["TX"][];
                if(this.shouldClaimCbk!=null) {
                    const feeData = await this.shouldClaimCbk(savedSwap);
                    if(feeData==null) {
                        console.log("Watchtower: syncToTipHash(): Not claiming swap with txoHash: "+txoHash+" due to negative response from shouldClaimCbk() callback!");
                        return;
                    }
                    console.log("Watchtower: syncToTipHash(): Claiming swap with txoHash: "+txoHash+" initAta: "+feeData.initAta+" feeRate: "+feeData.feeRate);
                    claimTxs = await this.createClaimTxs(
                        Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height,
                        computedHeaderMap, feeData.initAta, feeData.feeRate
                    );
                } else {
                    console.log("Watchtower: syncToTipHash(): Claiming swap with txoHash: "+txoHash);
                    claimTxs = await this.createClaimTxs(
                        Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height,
                        computedHeaderMap
                    );
                }

                if(claimTxs==null)  {
                    await this.remove(savedSwap.txoHash);
                } else {
                    return {
                        txs: claimTxs,
                        data: {
                            vout: data.vout,
                            swapData: savedSwap.swapData,
                            txId: data.txId,
                            blockheight: data.height,
                            maturedAt: data.height+savedSwap.swapData.getConfirmationsHint()-1,
                        }
                    }
                }
            } catch (e) {
                console.error(e);
            }
        } else {
            console.log("EscrowSwaps: tryGetClaimTxs(): Cannot get claim txns yet, txoHash: "+txoHash+" requiredBlockheight: "+requiredBlockHeight+" tipHeight: "+txoHash);
            return null
        }
    }

    async getClaimTxs(
        foundTxos?: Map<string, {txId: string, vout: number, height: number}>,
        computedHeaderMap?: {[blockheight: number]: B}
    ): Promise<{
        [txcHash: string]: WatchtowerClaimTxType<T>
    }> {
        const tipHeight = this.root.prunedTxoMap.tipHeight;

        const txs: {
            [txcHash: string]: WatchtowerClaimTxType<T>
        } = {};

        //Check txoHashes that got required confirmations in the to-be-synchronized blocks,
        // but they might be already pruned if we only checked after
        if(foundTxos!=null) {
            console.log("EscrowSwaps: getClaimTxs(): Checking found txos: ", foundTxos);
            for(let entry of foundTxos.entries()) {
                const txoHash = entry[0];
                const data = entry[1];
                txs[txoHash] = await this.tryGetClaimTxs(txoHash, data, tipHeight, computedHeaderMap);
            }
        }

        //Check all the txs, if they are already confirmed in these blocks
        console.log("EscrowSwaps: getClaimTxs(): Checking all saved swaps...");
        for(let txoHash of this.txoHashMap.keys()) {
            if(txs[txoHash]!=null) continue;
            const data = this.root.prunedTxoMap.getTxoObject(txoHash);
            if(data==null) continue;
            txs[txoHash] = await this.tryGetClaimTxs(txoHash, data, tipHeight, computedHeaderMap);
        }

        return txs;
    }

}

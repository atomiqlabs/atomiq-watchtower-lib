import {PrunedTxoMap} from "./PrunedTxoMap";
import * as fs from "fs/promises";
import {SavedSwap} from "./SavedSwap";
import {
    BtcStoredHeader,
    InitializeEvent,
    SwapEvent,
    ChainSwapType,
    BitcoinRpc,
    SwapDataVerificationError,
    ChainType, IStorageManager
} from "@atomiqlabs/base";


export class Watchtower<T extends ChainType, B extends BtcStoredHeader<any>> {

    readonly txoHashMap: Map<string, SavedSwap<T>> = new Map<string, SavedSwap<T>>();
    readonly escrowHashMap: Map<string, SavedSwap<T>> = new Map<string, SavedSwap<T>>();

    readonly btcRelay: T["BtcRelay"];

    readonly swapContract: T["Contract"];
    readonly swapEvents: T["Events"];
    readonly signer: T["Signer"];

    readonly bitcoinRpc: BitcoinRpc<any>;

    readonly prunedTxoMap: PrunedTxoMap;

    readonly storage: IStorageManager<SavedSwap<T>>;

    readonly shouldClaimCbk: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>;

    constructor(
        storage: IStorageManager<SavedSwap<T>>,
        wtHeightStorageFile: string,
        btcRelay: T["BtcRelay"],
        solEvents: T["Events"],
        swapContract: T["Contract"],
        signer: T["Signer"],
        bitcoinRpc: BitcoinRpc<any>,
        pruningFactor?: number,
        shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>
    ) {
        this.storage = storage;
        this.btcRelay = btcRelay;
        this.swapEvents = solEvents;
        this.swapContract = swapContract;
        this.signer = signer;
        this.bitcoinRpc = bitcoinRpc;
        this.prunedTxoMap = new PrunedTxoMap(wtHeightStorageFile, bitcoinRpc, pruningFactor);
        this.shouldClaimCbk = shouldClaimCbk;
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

        const tx = await this.bitcoinRpc.getTransaction(txId);

        //Re-check txoHash
        const vout = tx.outs[voutN];
        const computedTxoHash = PrunedTxoMap.toTxoHash(vout.value, vout.scriptPubKey.hex);

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
                this.signer, swap.swapData, {...tx, height: blockheight}, requiredConfirmations, voutN,
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
                const tx = await this.bitcoinRpc.getTransaction(txId);
                const requiredConfirmations = swap.swapData.getConfirmationsHint();
                await this.swapContract.claimWithTxData(
                    this.signer, swap.swapData, {...tx, height: blockheight}, requiredConfirmations, vout,
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

    async init() {
        await this.load();

        console.log("Watchtower: init(): Loaded!");

        this.swapEvents.registerListener(async (obj: SwapEvent<T["Data"]>[]) => {
            for(let event of obj) {
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
                    const data = this.prunedTxoMap.getTxoObject(txoHashHex);
                    if(data!=null) {
                        const requiredBlockHeight = data.height+savedSwap.swapData.getConfirmationsHint()-1;
                        if(requiredBlockHeight<=this.prunedTxoMap.tipHeight) {
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

        //Sync to latest on Solana
        await this.swapEvents.init();

        console.log("Watchtower: init(): Synchronized smart chain events");

        const resp = await this.btcRelay.retrieveLatestKnownBlockLog();

        //Sync to previously processed block
        await this.prunedTxoMap.init(resp.resultBitcoinHeader.height);

        for(let txoHash of this.txoHashMap.keys()) {
            const data = this.prunedTxoMap.getTxoObject(txoHash);
            console.log("Watchtower: init(): Check "+txoHash+":", data);
            if(data!=null) {
                const savedSwap = this.txoHashMap.get(txoHash);
                const requiredBlockHeight = data.height+savedSwap.swapData.getConfirmationsHint()-1;
                if(requiredBlockHeight<=resp.resultBitcoinHeader.height) {
                    //Claimable
                    await this.claim(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height);
                }
            }
        }

        console.log("Watchtower: init(): Synced to last processed block");

        //Sync watchtower to the btc relay height
        const includedTxoHashes = await this.prunedTxoMap.syncToTipHash(resp.resultBitcoinHeader.hash, this.txoHashMap);

        //Check if some of the txoHashes got confirmed
        for(let entry of includedTxoHashes.entries()) {
            const txoHash = entry[0];
            const data = entry[1];

            const savedSwap = this.txoHashMap.get(txoHash);
            const requiredBlockHeight = data.height+savedSwap.swapData.getConfirmationsHint()-1;
            if(requiredBlockHeight<=resp.resultBitcoinHeader.height) {
                //Claimable
                await this.claim(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height);
            }
        }

        console.log("Watchtower: init(): Synced to last btc relay block");
    }

    async syncToTipHash(
        tipBlockHash: string,
        computedHeaderMap?: {[blockheight: number]: B}
    ): Promise<{
        [txcHash: string]: {
            txs: T["TX"][],
            txId: string,
            vout: number,
            maturedAt: number,
            blockheight: number,
            swapData: T["Data"]
        }
    }> {
        console.log("[Watchtower.syncToTipHash]: Syncing to tip hash: ", tipBlockHash);

        const txs: {
            [txcHash: string]: {
                txs: T["TX"][],
                txId: string,
                vout: number,
                maturedAt: number,
                blockheight: number,
                swapData: T["Data"]
            }
        } = {};

        //Check txoHashes that got required confirmations in these blocks,
        // but they might be already pruned if we only checked after
        const includedTxoHashes = await this.prunedTxoMap.syncToTipHash(tipBlockHash, this.txoHashMap);

        for(let entry of includedTxoHashes.entries()) {
            const txoHash = entry[0];
            const data = entry[1];

            const savedSwap = this.txoHashMap.get(txoHash);
            const requiredBlockHeight = data.height+savedSwap.swapData.getConfirmationsHint()-1;
            if(requiredBlockHeight<=this.prunedTxoMap.tipHeight) {
                //Claimable
                try {
                    const unlock = savedSwap.lock(120);
                    if(unlock==null) continue;

                    //Check claimer's bounty and create ATA if the claimer bounty covers the costs of it!

                    let claimTxs: T["TX"][];
                    if(this.shouldClaimCbk!=null) {
                        const feeData = await this.shouldClaimCbk(savedSwap);
                        if(feeData==null) {
                            console.log("Watchtower: syncToTipHash(): Not claiming swap with txoHash: "+txoHash+" due to negative response from shouldClaimCbk() callback!");
                            continue;
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
                        txs[txoHash] = {
                            txs: claimTxs,
                            txId: data.txId,
                            vout: data.vout,
                            blockheight: data.height,
                            maturedAt: data.height+savedSwap.swapData.getConfirmationsHint()-1,
                            swapData: savedSwap.swapData
                        }
                    }
                } catch (e) {
                    console.error(e);
                }
            }
        }

        //Check all the txs, if they are already confirmed in these blocks
        for(let txoHash of this.txoHashMap.keys()) {
            const data = this.prunedTxoMap.getTxoObject(txoHash);
            if(data!=null) {
                const savedSwap = this.txoHashMap.get(txoHash);
                const requiredBlockHeight = data.height+savedSwap.swapData.getConfirmationsHint()-1;
                if(requiredBlockHeight<=this.prunedTxoMap.tipHeight) {
                    //Claimable
                    try {
                        const unlock = savedSwap.lock(120);
                        if(unlock==null) continue;

                        //Check claimer's bounty and create ATA if the claimer bounty covers the costs of it!

                        let claimTxs: T["TX"][];
                        if(this.shouldClaimCbk!=null) {
                            const feeData = await this.shouldClaimCbk(savedSwap);
                            if(feeData==null) {
                                console.log("Watchtower: syncToTipHash(): Not claiming swap with txoHash: "+txoHash+" due to negative response from shouldClaimCbk() callback!");
                                continue;
                            }
                            console.log("Watchtower: syncToTipHash(): Claiming swap with txoHash: "+txoHash+" initAta: "+feeData.initAta+" feeRate: "+feeData.feeRate);
                            claimTxs = await this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, computedHeaderMap, feeData.initAta, feeData.feeRate);
                        } else {
                            console.log("Watchtower: syncToTipHash(): Claiming swap with txoHash: "+txoHash);
                            claimTxs = await this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, computedHeaderMap);
                        }

                        if(claimTxs==null) {
                            await this.remove(savedSwap.txoHash);
                        } else {
                            txs[txoHash] = {
                                txs: claimTxs,
                                txId: data.txId,
                                vout: data.vout,
                                blockheight: data.height,
                                maturedAt: data.height+savedSwap.swapData.getConfirmationsHint()-1,
                                swapData: savedSwap.swapData
                            }
                        }
                    } catch (e) {
                        console.error(e);
                    }
                }
            }
        }

        return txs;
    }

}

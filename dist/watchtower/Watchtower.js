"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Watchtower = void 0;
const PrunedTxoMap_1 = require("./PrunedTxoMap");
const SavedSwap_1 = require("./SavedSwap");
const base_1 = require("@atomiqlabs/base");
class Watchtower {
    constructor(storage, wtHeightStorageFile, btcRelay, solEvents, swapContract, signer, bitcoinRpc, pruningFactor, shouldClaimCbk) {
        this.txoHashMap = new Map();
        this.escrowHashMap = new Map();
        this.storage = storage;
        this.btcRelay = btcRelay;
        this.swapEvents = solEvents;
        this.swapContract = swapContract;
        this.signer = signer;
        this.bitcoinRpc = bitcoinRpc;
        this.prunedTxoMap = new PrunedTxoMap_1.PrunedTxoMap(wtHeightStorageFile, bitcoinRpc, pruningFactor);
        this.shouldClaimCbk = shouldClaimCbk;
    }
    load() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.storage.init();
            const loadedData = yield this.storage.loadData(SavedSwap_1.SavedSwap);
            loadedData.forEach(swap => {
                this.txoHashMap.set(swap.txoHash.toString("hex"), swap);
                this.escrowHashMap.set(swap.swapData.getEscrowHash(), swap);
            });
        });
    }
    save(swap) {
        return __awaiter(this, void 0, void 0, function* () {
            this.txoHashMap.set(swap.txoHash.toString("hex"), swap);
            this.escrowHashMap.set(swap.swapData.getEscrowHash(), swap);
            yield this.storage.saveData(swap.txoHash.toString("hex"), swap);
        });
    }
    remove(txoHash) {
        return __awaiter(this, void 0, void 0, function* () {
            const swap = this.txoHashMap.get(txoHash.toString("hex"));
            if (swap == null)
                return false;
            this.txoHashMap.delete(swap.txoHash.toString("hex"));
            this.escrowHashMap.delete(swap.swapData.getEscrowHash());
            yield this.storage.removeData(swap.txoHash.toString("hex"));
            return true;
        });
    }
    removeByEscrowHash(escrowHash) {
        return __awaiter(this, void 0, void 0, function* () {
            const swap = this.escrowHashMap.get(escrowHash);
            if (swap == null)
                return false;
            this.txoHashMap.delete(swap.txoHash.toString("hex"));
            this.escrowHashMap.delete(swap.swapData.getEscrowHash());
            yield this.storage.removeData(swap.txoHash.toString("hex"));
            return true;
        });
    }
    createClaimTxs(txoHash, swap, txId, voutN, blockheight, computedCommitedHeaders, initAta, feeRate) {
        return __awaiter(this, void 0, void 0, function* () {
            const isCommited = yield this.swapContract.isCommited(swap.swapData);
            if (!isCommited) {
                console.log("Watchtower: createClaimTxs(): Not claiming swap txoHash: " + txoHash.toString("hex") + " due to it not being commited anymore!");
                return null;
            }
            console.log("Watchtower: createClaimTxs(): Claim swap txns: " + swap.swapData.getEscrowHash() + " UTXO: ", txId + ":" + voutN + "@" + blockheight);
            const tx = yield this.bitcoinRpc.getTransaction(txId);
            //Re-check txoHash
            const vout = tx.outs[voutN];
            const computedTxoHash = PrunedTxoMap_1.PrunedTxoMap.toTxoHash(vout.value, vout.scriptPubKey.hex);
            if (!txoHash.equals(computedTxoHash))
                throw new Error("TXO hash mismatch");
            const requiredConfirmations = swap.swapData.getConfirmationsHint();
            if (tx.confirmations < requiredConfirmations)
                throw new Error("Not enough confirmations yet");
            let storedHeader = null;
            if (computedCommitedHeaders != null) {
                storedHeader = computedCommitedHeaders[blockheight];
            }
            let txs;
            try {
                txs = yield this.swapContract.txsClaimWithTxData(this.signer, swap.swapData, Object.assign(Object.assign({}, tx), { height: blockheight }), requiredConfirmations, voutN, storedHeader, null, initAta == null ? false : initAta, feeRate);
            }
            catch (e) {
                if (e instanceof base_1.SwapDataVerificationError) {
                    console.log("Watchtower: createClaimTxs(): Not claiming swap txoHash: " + txoHash.toString("hex") + " due to SwapDataVerificationError!");
                    console.error(e);
                    return null;
                }
                throw e;
            }
            return txs;
        });
    }
    claim(txoHash, swap, txId, vout, blockheight) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log("Watchtower: claim(): Claim swap: " + swap.swapData.getEscrowHash() + " UTXO: ", txId + ":" + vout + "@" + blockheight);
            try {
                const unlock = swap.lock(120);
                if (unlock == null)
                    return false;
                let feeData;
                if (this.shouldClaimCbk != null) {
                    feeData = yield this.shouldClaimCbk(swap);
                    if (feeData == null) {
                        console.log("Watchtower: claim(): Not claiming swap with txoHash: " + txoHash.toString("hex") + " due to negative response from shouldClaimCbk() callback!");
                        return false;
                    }
                    console.log("Watchtower: claim(): Claiming swap with txoHash: " + txoHash + " initAta: " + feeData.initAta + " feeRate: " + feeData.feeRate);
                }
                else {
                    console.log("Watchtower: claim(): Claiming swap with txoHash: " + txoHash);
                }
                try {
                    const tx = yield this.bitcoinRpc.getTransaction(txId);
                    const requiredConfirmations = swap.swapData.getConfirmationsHint();
                    yield this.swapContract.claimWithTxData(this.signer, swap.swapData, Object.assign(Object.assign({}, tx), { height: blockheight }), requiredConfirmations, vout, null, null, (feeData === null || feeData === void 0 ? void 0 : feeData.initAta) == null ? false : feeData.initAta, {
                        waitForConfirmation: true,
                        feeRate: feeData === null || feeData === void 0 ? void 0 : feeData.feeRate
                    });
                }
                catch (e) {
                    if (e instanceof base_1.SwapDataVerificationError) {
                        yield this.remove(swap.txoHash);
                        return false;
                    }
                    return false;
                }
                console.log("Watchtower: claim(): Claim swap: " + swap.swapData.getEscrowHash() + " success!");
                yield this.remove(txoHash);
                unlock();
                return true;
            }
            catch (e) {
                console.error(e);
                return false;
            }
        });
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.load();
            console.log("Watchtower: init(): Loaded!");
            this.swapEvents.registerListener((obj) => __awaiter(this, void 0, void 0, function* () {
                for (let event of obj) {
                    if (event instanceof base_1.InitializeEvent) {
                        if (event.swapType !== base_1.ChainSwapType.CHAIN)
                            continue;
                        const swapData = yield event.swapData();
                        if (swapData.getTxoHashHint() == null || swapData.getConfirmationsHint() == null) {
                            console.log("Watchtower: chainsEventListener: Skipping escrow " + swapData.getEscrowHash() + " due to missing txoHash & confirmations hint");
                            continue;
                        }
                        const txoHash = Buffer.from(swapData.getTxoHashHint(), "hex");
                        const txoHashHex = txoHash.toString("hex");
                        const savedSwap = new SavedSwap_1.SavedSwap(txoHash, swapData);
                        console.log("Watchtower: chainsEventListener: Adding new swap to watchlist: ", savedSwap);
                        yield this.save(savedSwap);
                        //Check with pruned tx map
                        const data = this.prunedTxoMap.getTxoObject(txoHashHex);
                        if (data != null) {
                            const requiredBlockHeight = data.height + savedSwap.swapData.getConfirmationsHint() - 1;
                            if (requiredBlockHeight <= this.prunedTxoMap.tipHeight) {
                                //Claimable
                                const isCommited = yield this.swapContract.isCommited(swapData);
                                if (isCommited) {
                                    yield this.claim(txoHash, savedSwap, data.txId, data.vout, data.height);
                                }
                            }
                        }
                    }
                    else {
                        const success = yield this.removeByEscrowHash(event.escrowHash);
                        if (success) {
                            console.log("Watchtower: chainsEventListener: Removed swap from watchlist: ", event.escrowHash);
                        }
                    }
                }
                return true;
            }));
            //Sync to latest on Solana
            yield this.swapEvents.init();
            console.log("Watchtower: init(): Synchronized smart chain events");
            const resp = yield this.btcRelay.retrieveLatestKnownBlockLog();
            //Sync to previously processed block
            yield this.prunedTxoMap.init(resp.resultBitcoinHeader.height);
            for (let txoHash of this.txoHashMap.keys()) {
                const data = this.prunedTxoMap.getTxoObject(txoHash);
                console.log("Watchtower: init(): Check " + txoHash + ":", data);
                if (data != null) {
                    const savedSwap = this.txoHashMap.get(txoHash);
                    const requiredBlockHeight = data.height + savedSwap.swapData.getConfirmationsHint() - 1;
                    if (requiredBlockHeight <= resp.resultBitcoinHeader.height) {
                        //Claimable
                        yield this.claim(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height);
                    }
                }
            }
            console.log("Watchtower: init(): Synced to last processed block");
            //Sync watchtower to the btc relay height
            const includedTxoHashes = yield this.prunedTxoMap.syncToTipHash(resp.resultBitcoinHeader.hash, this.txoHashMap);
            //Check if some of the txoHashes got confirmed
            for (let entry of includedTxoHashes.entries()) {
                const txoHash = entry[0];
                const data = entry[1];
                const savedSwap = this.txoHashMap.get(txoHash);
                const requiredBlockHeight = data.height + savedSwap.swapData.getConfirmationsHint() - 1;
                if (requiredBlockHeight <= resp.resultBitcoinHeader.height) {
                    //Claimable
                    yield this.claim(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height);
                }
            }
            console.log("Watchtower: init(): Synced to last btc relay block");
        });
    }
    syncToTipHash(tipBlockHash, computedHeaderMap) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log("[Watchtower.syncToTipHash]: Syncing to tip hash: ", tipBlockHash);
            const txs = {};
            //Check txoHashes that got required confirmations in these blocks,
            // but they might be already pruned if we only checked after
            const includedTxoHashes = yield this.prunedTxoMap.syncToTipHash(tipBlockHash, this.txoHashMap);
            for (let entry of includedTxoHashes.entries()) {
                const txoHash = entry[0];
                const data = entry[1];
                const savedSwap = this.txoHashMap.get(txoHash);
                const requiredBlockHeight = data.height + savedSwap.swapData.getConfirmationsHint() - 1;
                if (requiredBlockHeight <= this.prunedTxoMap.tipHeight) {
                    //Claimable
                    try {
                        const unlock = savedSwap.lock(120);
                        if (unlock == null)
                            continue;
                        //Check claimer's bounty and create ATA if the claimer bounty covers the costs of it!
                        let claimTxs;
                        if (this.shouldClaimCbk != null) {
                            const feeData = yield this.shouldClaimCbk(savedSwap);
                            if (feeData == null) {
                                console.log("Watchtower: syncToTipHash(): Not claiming swap with txoHash: " + txoHash + " due to negative response from shouldClaimCbk() callback!");
                                continue;
                            }
                            console.log("Watchtower: syncToTipHash(): Claiming swap with txoHash: " + txoHash + " initAta: " + feeData.initAta + " feeRate: " + feeData.feeRate);
                            claimTxs = yield this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, computedHeaderMap, feeData.initAta, feeData.feeRate);
                        }
                        else {
                            console.log("Watchtower: syncToTipHash(): Claiming swap with txoHash: " + txoHash);
                            claimTxs = yield this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, computedHeaderMap);
                        }
                        if (claimTxs == null) {
                            yield this.remove(savedSwap.txoHash);
                        }
                        else {
                            txs[txoHash] = {
                                txs: claimTxs,
                                txId: data.txId,
                                vout: data.vout,
                                blockheight: data.height,
                                maturedAt: data.height + savedSwap.swapData.getConfirmationsHint() - 1,
                                swapData: savedSwap.swapData
                            };
                        }
                    }
                    catch (e) {
                        console.error(e);
                    }
                }
            }
            //Check all the txs, if they are already confirmed in these blocks
            for (let txoHash of this.txoHashMap.keys()) {
                const data = this.prunedTxoMap.getTxoObject(txoHash);
                if (data != null) {
                    const savedSwap = this.txoHashMap.get(txoHash);
                    const requiredBlockHeight = data.height + savedSwap.swapData.getConfirmationsHint() - 1;
                    if (requiredBlockHeight <= this.prunedTxoMap.tipHeight) {
                        //Claimable
                        try {
                            const unlock = savedSwap.lock(120);
                            if (unlock == null)
                                continue;
                            //Check claimer's bounty and create ATA if the claimer bounty covers the costs of it!
                            let claimTxs;
                            if (this.shouldClaimCbk != null) {
                                const feeData = yield this.shouldClaimCbk(savedSwap);
                                if (feeData == null) {
                                    console.log("Watchtower: syncToTipHash(): Not claiming swap with txoHash: " + txoHash + " due to negative response from shouldClaimCbk() callback!");
                                    continue;
                                }
                                console.log("Watchtower: syncToTipHash(): Claiming swap with txoHash: " + txoHash + " initAta: " + feeData.initAta + " feeRate: " + feeData.feeRate);
                                claimTxs = yield this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, computedHeaderMap, feeData.initAta, feeData.feeRate);
                            }
                            else {
                                console.log("Watchtower: syncToTipHash(): Claiming swap with txoHash: " + txoHash);
                                claimTxs = yield this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, computedHeaderMap);
                            }
                            if (claimTxs == null) {
                                yield this.remove(savedSwap.txoHash);
                            }
                            else {
                                txs[txoHash] = {
                                    txs: claimTxs,
                                    txId: data.txId,
                                    vout: data.vout,
                                    blockheight: data.height,
                                    maturedAt: data.height + savedSwap.swapData.getConfirmationsHint() - 1,
                                    swapData: savedSwap.swapData
                                };
                            }
                        }
                        catch (e) {
                            console.error(e);
                        }
                    }
                }
            }
            return txs;
        });
    }
}
exports.Watchtower = Watchtower;

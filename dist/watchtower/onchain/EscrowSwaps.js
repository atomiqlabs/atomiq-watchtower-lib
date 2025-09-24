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
exports.EscrowSwaps = void 0;
const SavedSwap_1 = require("../SavedSwap");
const PrunedTxMap_1 = require("./PrunedTxMap");
const base_1 = require("@atomiqlabs/base");
const Utils_1 = require("../../utils/Utils");
const logger = (0, Utils_1.getLogger)("EscrowSwaps: ");
class EscrowSwaps {
    constructor(root, storage, swapContract, shouldClaimCbk) {
        this.txoHashMap = new Map();
        this.escrowHashMap = new Map();
        this.root = root;
        this.storage = storage;
        this.swapContract = swapContract;
        this.shouldClaimCbk = shouldClaimCbk;
        this.root.swapEvents.registerListener((obj) => __awaiter(this, void 0, void 0, function* () {
            for (let event of obj) {
                if (!(event instanceof base_1.SwapEvent))
                    continue;
                if (event instanceof base_1.InitializeEvent) {
                    if (event.swapType !== base_1.ChainSwapType.CHAIN)
                        continue;
                    const swapData = yield event.swapData();
                    if (swapData.hasSuccessAction())
                        continue;
                    if (swapData.getTxoHashHint() == null || swapData.getConfirmationsHint() == null) {
                        logger.warn("chainsEventListener: Skipping escrow " + swapData.getEscrowHash() + " due to missing txoHash & confirmations hint");
                        continue;
                    }
                    const escrowHash = swapData.getEscrowHash();
                    if (this.storage.data[escrowHash] != null) {
                        logger.info(`chainsEventListener: Skipped adding new swap to watchlist, already there! escrowHash: ${escrowHash}`);
                        continue;
                    }
                    const txoHash = Buffer.from(swapData.getTxoHashHint(), "hex");
                    const txoHashHex = txoHash.toString("hex");
                    const savedSwap = new SavedSwap_1.SavedSwap(txoHash, swapData);
                    logger.info("chainsEventListener: Adding new swap to watchlist: ", savedSwap);
                    yield this.save(savedSwap);
                    //Check with pruned tx map
                    const data = this.root.prunedTxoMap.getTxoObject(txoHashHex);
                    if (data != null) {
                        const requiredBlockHeight = data.height + savedSwap.swapData.getConfirmationsHint() - 1;
                        if (requiredBlockHeight <= this.root.prunedTxoMap.tipHeight) {
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
                        logger.info("chainsEventListener: Removed swap from watchlist: ", event.escrowHash);
                    }
                }
            }
            return true;
        }));
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.load();
        });
    }
    load() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.storage.init();
            const loadedData = yield this.storage.loadData(SavedSwap_1.SavedSwap);
            loadedData.forEach(swap => {
                const txoHash = swap.txoHash.toString("hex");
                let arr = this.txoHashMap.get(txoHash);
                if (arr == null)
                    this.txoHashMap.set(txoHash, arr = []);
                arr.push(swap);
                this.escrowHashMap.set(swap.swapData.getEscrowHash(), swap);
            });
        });
    }
    save(swap) {
        return __awaiter(this, void 0, void 0, function* () {
            const txoHash = swap.txoHash.toString("hex");
            const escrowHash = swap.swapData.getEscrowHash();
            let arr = this.txoHashMap.get(txoHash);
            if (arr == null)
                this.txoHashMap.set(txoHash, arr = []);
            if (!arr.includes(swap))
                arr.push(swap);
            this.escrowHashMap.set(escrowHash, swap);
            yield this.storage.saveData(escrowHash, swap);
        });
    }
    remove(savedSwap) {
        return this.removeByEscrowHash(savedSwap.swapData.getEscrowHash());
    }
    removeByEscrowHash(escrowHash) {
        return __awaiter(this, void 0, void 0, function* () {
            const swap = this.escrowHashMap.get(escrowHash);
            if (swap == null)
                return false;
            const txoHash = swap.txoHash.toString("hex");
            const arr = this.txoHashMap.get(txoHash);
            if (arr != null) {
                const index = arr.indexOf(swap);
                if (index !== -1)
                    arr.splice(index, 1);
                if (arr.length === 0)
                    this.txoHashMap.delete(txoHash);
            }
            this.escrowHashMap.delete(escrowHash);
            yield this.storage.removeData(escrowHash);
            return true;
        });
    }
    createClaimTxs(txoHash, swap, txId, voutN, blockheight, computedCommitedHeaders, initAta, feeRate) {
        return __awaiter(this, void 0, void 0, function* () {
            const isCommited = yield this.swapContract.isCommited(swap.swapData);
            if (!isCommited) {
                logger.debug("createClaimTxs(): Not claiming swap txoHash: " + txoHash.toString("hex") + " due to it not being commited anymore!");
                return null;
            }
            logger.info("createClaimTxs(): Claim swap txns: " + swap.swapData.getEscrowHash() + " UTXO: ", txId + ":" + voutN + "@" + blockheight);
            const tx = yield this.root.bitcoinRpc.getTransaction(txId);
            //Re-check txoHash
            const vout = tx.outs[voutN];
            const computedTxoHash = PrunedTxMap_1.PrunedTxMap.toTxoHash(vout.value, vout.scriptPubKey.hex);
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
                txs = yield this.swapContract.txsClaimWithTxData(this.root.signer, swap.swapData, Object.assign(Object.assign({}, tx), { height: blockheight }), requiredConfirmations, voutN, storedHeader, null, initAta == null ? false : initAta, feeRate);
            }
            catch (e) {
                if (e instanceof base_1.SwapDataVerificationError) {
                    logger.warn("createClaimTxs(): Not claiming swap txoHash: " + txoHash.toString("hex") + " due to SwapDataVerificationError!", e);
                    return null;
                }
                throw e;
            }
            return txs;
        });
    }
    claim(txoHash, swap, txId, vout, blockheight) {
        return __awaiter(this, void 0, void 0, function* () {
            logger.info("claim(): Claim swap: " + swap.swapData.getEscrowHash() + " UTXO: ", txId + ":" + vout + "@" + blockheight);
            try {
                const unlock = swap.lock(120);
                if (unlock == null)
                    return false;
                let feeData;
                if (this.shouldClaimCbk != null) {
                    feeData = yield this.shouldClaimCbk(swap);
                    if (feeData == null) {
                        logger.debug("claim(): Not claiming swap with txoHash: " + txoHash.toString("hex") + " due to negative response from shouldClaimCbk() callback!");
                        return false;
                    }
                    logger.debug("claim(): Claiming swap with txoHash: " + txoHash + " initAta: " + feeData.initAta + " feeRate: " + feeData.feeRate);
                }
                else {
                    logger.debug("claim(): Claiming swap with txoHash: " + txoHash);
                }
                try {
                    const tx = yield this.root.bitcoinRpc.getTransaction(txId);
                    const requiredConfirmations = swap.swapData.getConfirmationsHint();
                    yield this.swapContract.claimWithTxData(this.root.signer, swap.swapData, Object.assign(Object.assign({}, tx), { height: blockheight }), requiredConfirmations, vout, null, null, (feeData === null || feeData === void 0 ? void 0 : feeData.initAta) == null ? false : feeData.initAta, {
                        waitForConfirmation: true,
                        feeRate: feeData === null || feeData === void 0 ? void 0 : feeData.feeRate
                    });
                }
                catch (e) {
                    if (e instanceof base_1.SwapDataVerificationError) {
                        yield this.remove(swap);
                        return false;
                    }
                    if (e instanceof base_1.TransactionRevertedError) {
                        logger.error(`claim(): Marking claim attempt failed (tx reverted) for swap with txoHash: ${txoHash}!`, e);
                        swap.claimAttemptFailed = true;
                        yield this.save(swap);
                        return false;
                    }
                    return false;
                }
                logger.info("claim(): Claim swap: " + swap.swapData.getEscrowHash() + " success!");
                yield this.remove(swap);
                unlock();
                return true;
            }
            catch (e) {
                logger.error("claim(): Error when claiming swap: " + swap.swapData.getEscrowHash(), e);
                return false;
            }
        });
    }
    tryGetClaimTxs(txoHash, data, tipHeight, computedHeaderMap) {
        return __awaiter(this, void 0, void 0, function* () {
            const savedSwaps = this.txoHashMap.get(txoHash);
            const result = [];
            for (let savedSwap of savedSwaps) {
                if (savedSwap.claimAttemptFailed)
                    continue;
                const requiredBlockHeight = data.height + savedSwap.swapData.getConfirmationsHint() - 1;
                if (requiredBlockHeight <= tipHeight) {
                    logger.debug("tryGetClaimTxs(): Getting claim txs for txoHash: " + txoHash + " txId: " + data.txId + " vout: " + data.vout);
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
                                logger.debug("tryGetClaimTxs(): Not claiming swap with txoHash: " + txoHash + " due to negative response from shouldClaimCbk() callback!");
                                continue;
                            }
                            logger.debug("tryGetClaimTxs(): Claiming swap with txoHash: " + txoHash + " initAta: " + feeData.initAta + " feeRate: " + feeData.feeRate);
                            claimTxs = yield this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, computedHeaderMap, feeData.initAta, feeData.feeRate);
                        }
                        else {
                            logger.debug("tryGetClaimTxs(): Claiming swap with txoHash: " + txoHash);
                            claimTxs = yield this.createClaimTxs(Buffer.from(txoHash, "hex"), savedSwap, data.txId, data.vout, data.height, computedHeaderMap);
                        }
                        if (claimTxs == null) {
                            yield this.remove(savedSwap);
                        }
                        else {
                            result.push({
                                getTxs: (height, checkClaimable) => __awaiter(this, void 0, void 0, function* () {
                                    if (height != null && height < requiredBlockHeight)
                                        return null;
                                    if (checkClaimable && !(yield this.swapContract.isCommited(savedSwap.swapData)))
                                        return null;
                                    return claimTxs;
                                }),
                                data: {
                                    vout: data.vout,
                                    swapData: savedSwap.swapData,
                                    txId: data.txId,
                                    blockheight: data.height,
                                    maturedAt: requiredBlockHeight,
                                }
                            });
                        }
                    }
                    catch (e) {
                        logger.error("tryGetClaimTxs(): Error getting claim txs for txoHash: " + txoHash + " txId: " + data.txId + " vout: " + data.vout, e);
                    }
                }
                else {
                    logger.warn("tryGetClaimTxs(): Cannot get claim txns yet, txoHash: " + txoHash + " requiredBlockheight: " + requiredBlockHeight + " tipHeight: " + tipHeight);
                    continue;
                }
            }
            return result;
        });
    }
    markEscrowClaimReverted(escrowHash) {
        return __awaiter(this, void 0, void 0, function* () {
            const savedSwap = this.escrowHashMap.get(escrowHash);
            if (savedSwap == null)
                return false;
            savedSwap.claimAttemptFailed = true;
            yield this.save(savedSwap);
            return true;
        });
    }
    getClaimTxs(foundTxos, computedHeaderMap) {
        return __awaiter(this, void 0, void 0, function* () {
            const tipHeight = this.root.prunedTxoMap.tipHeight;
            const txs = {};
            //Check txoHashes that got required confirmations in the to-be-synchronized blocks,
            // but they might be already pruned if we only checked after
            if (foundTxos != null) {
                logger.debug("getClaimTxs(): Checking found txos: ", foundTxos);
                for (let entry of foundTxos.entries()) {
                    const txoHash = entry[0];
                    const data = entry[1];
                    const claimTxDataArray = yield this.tryGetClaimTxs(txoHash, data, tipHeight, computedHeaderMap);
                    claimTxDataArray.forEach(value => {
                        const data = value.data;
                        const escrowHash = data.swapData.getEscrowHash();
                        txs[escrowHash] = value;
                    });
                }
            }
            //Check all the txs, if they are already confirmed in these blocks
            logger.debug("getClaimTxs(): Checking all saved swaps...");
            for (let txoHash of this.txoHashMap.keys()) {
                if (foundTxos != null && foundTxos.has(txoHash))
                    continue;
                const data = this.root.prunedTxoMap.getTxoObject(txoHash);
                if (data == null)
                    continue;
                const claimTxDataArray = yield this.tryGetClaimTxs(txoHash, data, tipHeight, computedHeaderMap);
                claimTxDataArray.forEach(value => {
                    const data = value.data;
                    const escrowHash = data.swapData.getEscrowHash();
                    txs[escrowHash] = value;
                });
            }
            return txs;
        });
    }
}
exports.EscrowSwaps = EscrowSwaps;

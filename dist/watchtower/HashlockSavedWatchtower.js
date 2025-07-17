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
exports.HashlockSavedWatchtower = void 0;
const base_1 = require("@atomiqlabs/base");
const Utils_1 = require("../utils/Utils");
const SavedSwap_1 = require("./SavedSwap");
const PrunedSecretsMap_1 = require("../utils/PrunedSecretsMap");
const crypto_1 = require("crypto");
const logger = (0, Utils_1.getLogger)("HashlockWatchtower: ");
class HashlockSavedWatchtower {
    constructor(storage, messenger, chainEvents, swapContract, swapDataType, signer, escrowShouldClaimCbk) {
        this.escrowHashMap = new Map();
        this.secretsMap = new PrunedSecretsMap_1.PrunedSecretsMap();
        this.claimsInProcess = {};
        this.storage = storage;
        this.swapEvents = chainEvents;
        this.swapContract = swapContract;
        this.signer = signer;
        this.swapDataType = swapDataType;
        this.signer = signer;
        this.messenger = messenger;
        this.shouldClaimCbk = escrowShouldClaimCbk;
        this.swapEvents.registerListener((obj) => __awaiter(this, void 0, void 0, function* () {
            for (let event of obj) {
                if (!(event instanceof base_1.SwapEvent))
                    continue;
                if (event instanceof base_1.InitializeEvent) {
                    if (event.swapType !== base_1.ChainSwapType.HTLC)
                        continue;
                    const swapData = yield event.swapData();
                    if (swapData.hasSuccessAction())
                        continue;
                    const savedSwap = SavedSwap_1.SavedSwap.fromSwapData(swapData);
                    logger.info("chainsEventListener: Adding new swap to watchlist: ", savedSwap);
                    yield this.save(savedSwap);
                    const escrowHash = swapData.getEscrowHash();
                    const witness = this.secretsMap.get(escrowHash);
                    if (witness == null)
                        continue;
                    if (this.claimsInProcess[escrowHash] != null) {
                        logger.debug("chainsEventListener: Skipping escrowHash: " + escrowHash + " due to already being processed!");
                        continue;
                    }
                    this.claimsInProcess[escrowHash] = this.claim(swapData, witness).then(() => {
                        delete this.claimsInProcess[escrowHash];
                        logger.debug("chainsEventListener: Removing swap escrowHash: " + escrowHash + " due to claim being successful!");
                        this.remove(swapData);
                    }, (e) => {
                        logger.error("chainsEventListener: Error when claiming swap escrowHash: " + escrowHash, e);
                        delete this.claimsInProcess[escrowHash];
                    });
                }
                else {
                    const success = yield this.remove(event.escrowHash);
                    if (success) {
                        logger.info("chainsEventListener: Removed swap from watchlist: ", event.escrowHash);
                    }
                }
            }
            return true;
        }));
    }
    load() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.storage.init();
            const loadedData = yield this.storage.loadData(SavedSwap_1.SavedSwap);
            loadedData.forEach(swap => {
                this.escrowHashMap.set(swap.swapData.getEscrowHash(), swap);
            });
        });
    }
    save(swap) {
        return __awaiter(this, void 0, void 0, function* () {
            const escrowHash = swap.swapData.getEscrowHash();
            this.escrowHashMap.set(escrowHash, swap);
            yield this.storage.saveData(escrowHash, swap);
        });
    }
    remove(escrowHash) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.escrowHashMap.delete(escrowHash))
                return false;
            yield this.storage.removeData(escrowHash);
            return true;
        });
    }
    claim(swapData, witness) {
        return __awaiter(this, void 0, void 0, function* () {
            const isCommitted = yield this.swapContract.isCommited(swapData);
            if (!isCommitted)
                return;
            if (this.shouldClaimCbk != null) {
                const feeData = yield this.shouldClaimCbk(SavedSwap_1.SavedSwap.fromSwapData(swapData));
                if (feeData == null) {
                    logger.debug("claim(): Not claiming swap with escrowHash: " + swapData.getEscrowHash() + " due to negative response from shouldClaimCbk() callback!");
                    return;
                }
                yield this.swapContract.claimWithSecret(this.signer, swapData, witness, false, feeData.initAta, { feeRate: feeData.feeRate, waitForConfirmation: true });
            }
            else {
                yield this.swapContract.claimWithSecret(this.signer, swapData, witness, false, undefined, { waitForConfirmation: true });
            }
            logger.info("claim(): Claimed successfully escrowHash: " + swapData.getEscrowHash() + " with witness: " + witness + "!");
        });
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.load();
            logger.info("init(): Initialized!");
        });
    }
    subscribeToMessages() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.messenger.init();
            yield this.messenger.subscribe((_msg) => {
                if (_msg.type !== base_1.MessageType.SWAP_CLAIM_WITNESS)
                    return;
                const msg = _msg;
                if (!(msg.swapData instanceof this.swapDataType))
                    return;
                if (msg.swapData.getType() !== base_1.ChainSwapType.HTLC)
                    return;
                try {
                    const parsedWitness = Buffer.from(msg.witness, "hex");
                    if (parsedWitness.length !== 32)
                        return;
                    const paymentHash = (0, crypto_1.createHash)("sha256").update(parsedWitness).digest();
                    const expectedClaimHash = this.swapContract.getHashForHtlc(paymentHash);
                    if (msg.swapData.getClaimHash() !== expectedClaimHash.toString("hex"))
                        return;
                }
                catch (e) {
                    return;
                }
                const escrowHash = msg.swapData.getEscrowHash();
                if (this.secretsMap.set(escrowHash, msg.witness))
                    logger.debug("messageListener: Added new known secret: " + msg.witness + " escrowHash: " + escrowHash);
                if (!this.escrowHashMap.has(escrowHash)) {
                    logger.debug("messageListener: Skipping escrowHash: " + escrowHash + " due to swap not being initiated!");
                    return;
                }
                if (this.claimsInProcess[escrowHash] != null) {
                    logger.debug("messageListener: Skipping escrowHash: " + escrowHash + " due to already being processed!");
                    return;
                }
                logger.info("messageListener: Attempting to claim escrowHash: " + escrowHash + " with secret: " + msg.witness + "!");
                this.claimsInProcess[escrowHash] = this.claim(msg.swapData, msg.witness).then(() => {
                    delete this.claimsInProcess[escrowHash];
                }, (e) => {
                    logger.error("messageListener: Error when claiming swap escrowHash: " + escrowHash);
                    delete this.claimsInProcess[escrowHash];
                });
            });
            logger.info("subscribeToMessages(): Subscribed to messages!");
        });
    }
}
exports.HashlockSavedWatchtower = HashlockSavedWatchtower;

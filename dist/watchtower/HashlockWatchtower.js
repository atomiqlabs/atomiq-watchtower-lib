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
exports.HashlockWatchtower = void 0;
const base_1 = require("@atomiqlabs/base");
const Utils_1 = require("../utils/Utils");
const SavedSwap_1 = require("./SavedSwap");
const logger = (0, Utils_1.getLogger)("HashlockWatchtower: ");
class HashlockWatchtower {
    constructor(messenger, swapContract, swapDataType, signer, escrowShouldClaimCbk) {
        this.swapContract = swapContract;
        this.signer = signer;
        this.swapDataType = swapDataType;
        this.signer = signer;
        this.messenger = messenger;
        this.shouldClaimCbk = escrowShouldClaimCbk;
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
                }
                catch (e) {
                    return;
                }
                const escrowHash = msg.swapData.getEscrowHash();
                if (this.claimsInProcess[escrowHash] != null) {
                    logger.debug("messageListener: Skipping escrowHash: " + escrowHash + " due to already being processed!");
                    return;
                }
                this.claimsInProcess[escrowHash] = this.claim(msg.swapData, msg.witness).then(() => {
                    delete this.claimsInProcess[escrowHash];
                }, (e) => {
                    logger.error("messageListener: Error when claiming swap escrowHash: " + escrowHash);
                    delete this.claimsInProcess[escrowHash];
                });
            });
            logger.info("init(): Initialized!");
        });
    }
}
exports.HashlockWatchtower = HashlockWatchtower;

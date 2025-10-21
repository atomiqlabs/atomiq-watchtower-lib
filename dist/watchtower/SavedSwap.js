"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SavedSwap = void 0;
const Lockable_1 = require("./Lockable");
const base_1 = require("@atomiqlabs/base");
class SavedSwap extends Lockable_1.Lockable {
    constructor(txoHashOrObj, swapData) {
        super();
        if (swapData != null) {
            this.txoHash = txoHashOrObj;
            this.swapData = swapData;
            this.claimAttemptFailed = false;
        }
        else {
            this.txoHash = txoHashOrObj.txoHash == null ? null : Buffer.from(txoHashOrObj.txoHash, "hex");
            this.swapData = base_1.SwapData.deserialize(txoHashOrObj.swapData);
            this.claimAttemptFailed = txoHashOrObj.claimAttemptFailed;
        }
    }
    serialize() {
        return {
            txoHash: this.txoHash == null ? null : this.txoHash.toString("hex"),
            swapData: this.swapData.serialize(),
            claimAttemptFailed: this.claimAttemptFailed
        };
    }
    static fromSwapData(swapData) {
        return new SavedSwap(swapData.getTxoHashHint() == null ? null : Buffer.from(swapData.getTxoHashHint(), "hex"), swapData);
    }
}
exports.SavedSwap = SavedSwap;

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
        }
        else {
            this.txoHash = Buffer.from(txoHashOrObj.txoHash, "hex");
            this.swapData = base_1.SwapData.deserialize(txoHashOrObj.swapData);
        }
    }
    serialize() {
        return {
            txoHash: this.txoHash.toString("hex"),
            swapData: this.swapData.serialize()
        };
    }
}
exports.SavedSwap = SavedSwap;

import {Lockable} from "./Lockable";
import {ChainType, SwapData} from "@atomiqlabs/base";

export class SavedSwap<T extends ChainType> extends Lockable {

    readonly txoHash: Buffer;
    readonly swapData: T["Data"];
    claimAttemptFailed: boolean;

    constructor(data: any);
    constructor(txoHash: Buffer, swapData: T["Data"]);

    constructor(txoHashOrObj: Buffer | any, swapData?: T["Data"]) {
        super();
        if(swapData!=null) {
            this.txoHash = txoHashOrObj;
            this.swapData = swapData;
            this.claimAttemptFailed = false;
        } else {
            this.txoHash = txoHashOrObj.txoHash==null ? null : Buffer.from(txoHashOrObj.txoHash, "hex");
            this.swapData = SwapData.deserialize(txoHashOrObj.swapData);
            this.claimAttemptFailed = txoHashOrObj.claimAttemptFailed;
        }
    }

    serialize(): any {
        return {
            txoHash: this.txoHash==null ? null : this.txoHash.toString("hex"),
            swapData: this.swapData.serialize(),
            claimAttemptFailed: this.claimAttemptFailed
        }
    }

    static fromSwapData<T extends ChainType>(swapData: T["Data"]): SavedSwap<T> {
        return new SavedSwap<T>(swapData.getTxoHashHint()==null ? null : Buffer.from(swapData.getTxoHashHint(), "hex"), swapData);
    }

}

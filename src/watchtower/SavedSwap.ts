import {Lockable} from "./Lockable";
import {ChainType, SwapData} from "@atomiqlabs/base";

export class SavedSwap<T extends ChainType> extends Lockable {

    readonly txoHash: Buffer;
    readonly swapData: T["Data"];

    constructor(data: any);
    constructor(txoHash: Buffer, swapData: T["Data"]);

    constructor(txoHashOrObj: Buffer | any, swapData?: T["Data"]) {
        super();
        if(swapData!=null) {
            this.txoHash = txoHashOrObj;
            this.swapData = swapData;
        } else {
            this.txoHash = Buffer.from(txoHashOrObj.txoHash, "hex");
            this.swapData = SwapData.deserialize(txoHashOrObj.swapData);
        }
    }

    serialize(): any {
        return {
            txoHash: this.txoHash.toString("hex"),
            swapData: this.swapData.serialize()
        }
    }

}

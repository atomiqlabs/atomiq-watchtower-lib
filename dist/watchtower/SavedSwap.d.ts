/// <reference types="node" />
import { Lockable } from "./Lockable";
import { ChainType } from "@atomiqlabs/base";
export declare class SavedSwap<T extends ChainType> extends Lockable {
    readonly txoHash: Buffer;
    readonly swapData: T["Data"];
    claimAttemptFailed: boolean;
    constructor(data: any);
    constructor(txoHash: Buffer, swapData: T["Data"]);
    serialize(): any;
    static fromSwapData<T extends ChainType>(swapData: T["Data"]): SavedSwap<T>;
}

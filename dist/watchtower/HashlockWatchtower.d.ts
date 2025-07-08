import { ChainType, Messenger } from "@atomiqlabs/base";
import { SavedSwap } from "./SavedSwap";
export declare class HashlockWatchtower<T extends ChainType> {
    readonly signer: T["Signer"];
    readonly swapContract: T["Contract"];
    readonly swapDataType: {
        new (): T["Data"];
    };
    readonly shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>;
    readonly messenger: Messenger;
    constructor(messenger: Messenger, swapContract: T["Contract"], swapDataType: {
        new (): T["Data"];
    }, signer: T["Signer"], escrowShouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>);
    claim(swapData: T["Data"], witness: string): Promise<void>;
    readonly claimsInProcess: {
        [escrowHash: string]: Promise<void>;
    };
    init(): Promise<void>;
}

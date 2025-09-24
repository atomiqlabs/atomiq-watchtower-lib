import { ChainType, IStorageManager, Messenger } from "@atomiqlabs/base";
import { SavedSwap } from "./SavedSwap";
import { PrunedSecretsMap } from "../utils/PrunedSecretsMap";
export declare class HashlockSavedWatchtower<T extends ChainType> {
    readonly storage: IStorageManager<SavedSwap<T>>;
    readonly swapEvents: T["Events"];
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
    readonly escrowHashMap: Map<string, SavedSwap<T>>;
    readonly secretsMap: PrunedSecretsMap;
    constructor(storage: IStorageManager<SavedSwap<T>>, messenger: Messenger, chainEvents: T["Events"], swapContract: T["Contract"], swapDataType: {
        new (): T["Data"];
    }, signer: T["Signer"], escrowShouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>);
    private load;
    private save;
    private remove;
    claim(swapData: T["Data"], witness: string): Promise<void>;
    attemptClaim(savedSwap: SavedSwap<T>, witness: string): void;
    readonly claimsInProcess: {
        [escrowHash: string]: Promise<void>;
    };
    init(): Promise<void>;
    subscribeToMessages(): Promise<void>;
}

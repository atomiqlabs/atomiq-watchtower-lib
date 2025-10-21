import { SavedSwap } from "../SavedSwap";
import { BtcStoredHeader, ChainType, IStorageManager } from "@atomiqlabs/base";
import { BtcRelayWatchtower, WatchtowerClaimTxType } from "./BtcRelayWatchtower";
export declare class EscrowSwaps<T extends ChainType, B extends BtcStoredHeader<any>> {
    readonly txoHashMap: Map<string, SavedSwap<T>[]>;
    readonly escrowHashMap: Map<string, SavedSwap<T>>;
    readonly storage: IStorageManager<SavedSwap<T>>;
    readonly swapContract: T["Contract"];
    readonly root: BtcRelayWatchtower<T, B>;
    readonly shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>;
    constructor(root: BtcRelayWatchtower<T, B>, storage: IStorageManager<SavedSwap<T>>, swapContract: T["Contract"], shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>);
    init(): Promise<void>;
    private load;
    private save;
    private remove;
    private removeByEscrowHash;
    private createClaimTxs;
    private claim;
    private tryGetClaimTxs;
    markEscrowClaimReverted(escrowHash: string): Promise<boolean>;
    getClaimTxs(foundTxos?: Map<string, {
        txId: string;
        vout: number;
        height: number;
    }>, computedHeaderMap?: {
        [blockheight: number]: B;
    }): Promise<{
        [escrowHash: string]: WatchtowerClaimTxType<T>;
    }>;
}

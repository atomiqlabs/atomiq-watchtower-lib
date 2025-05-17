import { SavedSwap } from "./SavedSwap";
import { BtcStoredHeader, ChainType, IStorageManager } from "@atomiqlabs/base";
import { Watchtower, WatchtowerClaimTxType } from "./Watchtower";
export declare class EscrowSwaps<T extends ChainType, B extends BtcStoredHeader<any>> {
    readonly txoHashMap: Map<string, SavedSwap<T>>;
    readonly escrowHashMap: Map<string, SavedSwap<T>>;
    readonly storage: IStorageManager<SavedSwap<T>>;
    readonly swapContract: T["Contract"];
    readonly root: Watchtower<T, B>;
    readonly shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>;
    constructor(root: Watchtower<T, B>, storage: IStorageManager<SavedSwap<T>>, swapContract: T["Contract"], shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{
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
    getClaimTxs(foundTxos?: Map<string, {
        txId: string;
        vout: number;
        height: number;
    }>, computedHeaderMap?: {
        [blockheight: number]: B;
    }): Promise<{
        [txcHash: string]: WatchtowerClaimTxType<T>;
    }>;
}

import { PrunedTxoMap } from "./PrunedTxoMap";
import { SavedSwap } from "./SavedSwap";
import { BtcStoredHeader, BitcoinRpc, ChainType, IStorageManager } from "@atomiqlabs/base";
export declare class Watchtower<T extends ChainType, B extends BtcStoredHeader<any>> {
    readonly txoHashMap: Map<string, SavedSwap<T>>;
    readonly escrowHashMap: Map<string, SavedSwap<T>>;
    readonly btcRelay: T["BtcRelay"];
    readonly swapContract: T["Contract"];
    readonly swapEvents: T["Events"];
    readonly signer: T["Signer"];
    readonly bitcoinRpc: BitcoinRpc<any>;
    readonly prunedTxoMap: PrunedTxoMap;
    readonly storage: IStorageManager<SavedSwap<T>>;
    readonly shouldClaimCbk: (swap: SavedSwap<T>) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>;
    constructor(storage: IStorageManager<SavedSwap<T>>, wtHeightStorageFile: string, btcRelay: T["BtcRelay"], solEvents: T["Events"], swapContract: T["Contract"], signer: T["Signer"], bitcoinRpc: BitcoinRpc<any>, pruningFactor?: number, shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>);
    private load;
    private save;
    private remove;
    private removeByEscrowHash;
    private createClaimTxs;
    private claim;
    init(): Promise<void>;
    syncToTipHash(tipBlockHash: string, computedHeaderMap?: {
        [blockheight: number]: B;
    }): Promise<{
        [txcHash: string]: {
            txs: T["TX"][];
            txId: string;
            vout: number;
            maturedAt: number;
            blockheight: number;
            swapData: T["Data"];
        };
    }>;
}

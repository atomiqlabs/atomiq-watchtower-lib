import { PrunedTxMap } from "./PrunedTxMap";
import { SavedSwap } from "../SavedSwap";
import { BtcStoredHeader, BitcoinRpc, ChainType, IStorageManager } from "@atomiqlabs/base";
import { EscrowSwaps } from "./EscrowSwaps";
import { SpvVaultSwaps } from "./SpvVaultSwaps";
export type WatchtowerEscrowClaimData<T extends ChainType> = {
    txId: string;
    vout: number;
    maturedAt: number;
    blockheight: number;
    swapData: T["Data"];
};
export type WatchtowerSpvVaultClaimData<T extends ChainType> = {
    vault: T["SpvVaultData"];
    withdrawals: {
        txId: string;
        maturedAt: number;
        blockheight: number;
        data: T["SpvVaultWithdrawalData"];
    }[];
};
export type WatchtowerClaimTxType<T extends ChainType> = {
    getTxs: (height?: number, checkClaimable?: boolean) => Promise<T["TX"][] | null>;
    data: WatchtowerEscrowClaimData<T> | WatchtowerSpvVaultClaimData<T>;
};
export declare class BtcRelayWatchtower<T extends ChainType, B extends BtcStoredHeader<any>> {
    readonly btcRelay: T["BtcRelay"];
    readonly swapEvents: T["Events"];
    readonly signer: T["Signer"];
    readonly bitcoinRpc: BitcoinRpc<any>;
    readonly prunedTxoMap: PrunedTxMap;
    readonly EscrowSwaps: EscrowSwaps<T, B>;
    readonly SpvVaultSwaps: SpvVaultSwaps<T, B>;
    constructor(storage: IStorageManager<SavedSwap<T>>, vaultStorage: IStorageManager<T["SpvVaultData"]>, wtHeightStorageFile: string, btcRelay: T["BtcRelay"], chainEvents: T["Events"], swapContract: T["Contract"], spvVaultContract: T["SpvVaultContract"], spvVaultDataDeserializer: new (obj: any) => T["SpvVaultData"], signer: T["Signer"], bitcoinRpc: BitcoinRpc<any>, pruningFactor?: number, escrowShouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>, vaultShouldClaimCbk?: (vault: T["SpvVaultData"], txs: T["SpvVaultWithdrawalData"][]) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>);
    init(): Promise<void>;
    initialSync(): Promise<{
        [identifier: string]: WatchtowerClaimTxType<T>;
    }>;
    syncToTipHash(newTipBlockHash: string, computedHeaderMap?: {
        [blockheight: number]: B;
    }): Promise<{
        [identifier: string]: WatchtowerClaimTxType<T>;
    }>;
    markClaimReverted(escrowHash: string): Promise<boolean>;
}

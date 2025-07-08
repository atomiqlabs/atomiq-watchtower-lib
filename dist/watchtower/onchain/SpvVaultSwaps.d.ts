import { BtcStoredHeader, ChainType, IStorageManager } from "@atomiqlabs/base";
import { BtcRelayWatchtower, WatchtowerClaimTxType } from "./BtcRelayWatchtower";
export declare class SpvVaultSwaps<T extends ChainType, B extends BtcStoredHeader<any>> {
    readonly txinMap: Map<string, T["SpvVaultData"]>;
    readonly storage: IStorageManager<T["SpvVaultData"]>;
    readonly deserializer: new (data: any) => T["SpvVaultData"];
    readonly spvVaultContract: T["SpvVaultContract"];
    readonly root: BtcRelayWatchtower<T, B>;
    readonly shouldClaimCbk?: (vault: T["SpvVaultData"], swapData: T["SpvVaultWithdrawalData"][]) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>;
    constructor(root: BtcRelayWatchtower<T, B>, storage: IStorageManager<T["SpvVaultData"]>, deserializer: new (data: any) => T["SpvVaultData"], spvVaultContract: T["SpvVaultContract"], shouldClaimCbk?: (vault: T["SpvVaultData"], swapData: T["SpvVaultWithdrawalData"][]) => Promise<{
        initAta: boolean;
        feeRate: any;
    }>);
    init(): Promise<void>;
    private load;
    private getIdentifier;
    private save;
    private remove;
    private tryGetClaimTxs;
    getClaimTxs(foundTxins?: Map<string, {
        txId: string;
        height: number;
    }>, computedHeaderMap?: {
        [blockheight: number]: B;
    }): Promise<{
        [vaultIdentifier: string]: WatchtowerClaimTxType<T>;
    }>;
}

import {PrunedTxMap} from "./PrunedTxMap";
import {SavedSwap} from "./SavedSwap";
import {
    BtcStoredHeader,
    BitcoinRpc,
    ChainType, IStorageManager
} from "@atomiqlabs/base";
import { EscrowSwaps } from "./EscrowSwaps";
import { SpvVaultSwaps } from "./SpvVaultSwaps";
import {getLogger} from "../utils/Utils";

export type WatchtowerEscrowClaimData<T extends ChainType> = {
    txId: string,
    vout: number,
    maturedAt: number,
    blockheight: number,
    swapData: T["Data"],
};

export type WatchtowerSpvVaultClaimData<T extends ChainType> = {
    vault: T["SpvVaultData"],
    withdrawals: {
        txId: string;
        maturedAt: number;
        blockheight: number;
        data: T["SpvVaultWithdrawalData"];
    }[];
};

export type WatchtowerClaimTxType<T extends ChainType> = {
    getTxs: (height?: number, checkClaimable?: boolean) => Promise<T["TX"][] | null>,
    data: WatchtowerEscrowClaimData<T> | WatchtowerSpvVaultClaimData<T>
};

const logger = getLogger("Watchtower");

export class Watchtower<T extends ChainType, B extends BtcStoredHeader<any>> {

    readonly btcRelay: T["BtcRelay"];

    readonly swapEvents: T["Events"];
    readonly signer: T["Signer"];

    readonly bitcoinRpc: BitcoinRpc<any>;

    readonly prunedTxoMap: PrunedTxMap;

    readonly EscrowSwaps: EscrowSwaps<T, B>;
    readonly SpvVaultSwaps: SpvVaultSwaps<T, B>;

    constructor(
        storage: IStorageManager<SavedSwap<T>>,
        vaultStorage: IStorageManager<T["SpvVaultData"]>,
        wtHeightStorageFile: string,
        btcRelay: T["BtcRelay"],
        chainEvents: T["Events"],
        swapContract: T["Contract"],
        spvVaultContract: T["SpvVaultContract"],
        spvVaultDataDeserializer: new (obj: any) => T["SpvVaultData"],
        signer: T["Signer"],
        bitcoinRpc: BitcoinRpc<any>,
        pruningFactor?: number,
        escrowShouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>,
        vaultShouldClaimCbk?: (vault: T["SpvVaultData"], txs: T["SpvVaultWithdrawalData"][]) => Promise<{initAta: boolean, feeRate: any}>
    ) {
        this.btcRelay = btcRelay;
        this.swapEvents = chainEvents;
        this.signer = signer;
        this.bitcoinRpc = bitcoinRpc;
        this.prunedTxoMap = new PrunedTxMap(wtHeightStorageFile, bitcoinRpc, pruningFactor);
        this.EscrowSwaps = new EscrowSwaps(this, storage, swapContract, escrowShouldClaimCbk);
        if(spvVaultContract!=null) this.SpvVaultSwaps = new SpvVaultSwaps(this, vaultStorage, spvVaultDataDeserializer, spvVaultContract, vaultShouldClaimCbk)
    }

    async init(): Promise<{
        [identifier: string]: WatchtowerClaimTxType<T>
    }> {
        await this.EscrowSwaps.init();
        if(this.SpvVaultSwaps!=null) await this.SpvVaultSwaps.init();

        logger.info("init(): Loaded!");

        //Sync to latest on Solana
        await this.swapEvents.init();

        logger.info("init(): Synchronized smart chain events");

        const resp = await this.btcRelay.retrieveLatestKnownBlockLog();

        //Sync to previously processed block
        await this.prunedTxoMap.init(resp.resultBitcoinHeader.height);
        logger.info("init(): Synced to last processed block");

        //Sync watchtower to the btc relay height and get all the claim txs
        return  await this.syncToTipHash(resp.resultBitcoinHeader.hash);
    }

    async syncToTipHash(
        newTipBlockHash: string,
        computedHeaderMap?: {[blockheight: number]: B}
    ): Promise<{
        [identifier: string]: WatchtowerClaimTxType<T>
    }> {
        logger.info("syncToTipHash(): Syncing to tip hash: ", newTipBlockHash);

        //Check txoHashes that got required confirmations in these blocks,
        // but they might be already pruned if we only checked after
        const {foundTxos, foundTxins} = await this.prunedTxoMap.syncToTipHash(newTipBlockHash, this.EscrowSwaps.txoHashMap, this.SpvVaultSwaps?.txinMap);
        logger.debug("syncToTipHash(): Returned found txins: ", foundTxins);

        const escrowClaimTxs = await this.EscrowSwaps.getClaimTxs(foundTxos, computedHeaderMap);
        const spvVaultClaimTxs = this.SpvVaultSwaps==null ? {} : await this.SpvVaultSwaps.getClaimTxs(foundTxins, computedHeaderMap);
        logger.debug("syncToTipHash(): Returned escrow claim txs: ", escrowClaimTxs);
        logger.debug("syncToTipHash(): Returned spv vault claim txs: ", spvVaultClaimTxs);

        return {
            ...escrowClaimTxs,
            ...spvVaultClaimTxs
        }
    }

}

"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Watchtower = void 0;
const PrunedTxMap_1 = require("./PrunedTxMap");
const EscrowSwaps_1 = require("./EscrowSwaps");
const SpvVaultSwaps_1 = require("./SpvVaultSwaps");
class Watchtower {
    constructor(storage, vaultStorage, wtHeightStorageFile, btcRelay, chainEvents, swapContract, spvVaultContract, spvVaultDataDeserializer, signer, bitcoinRpc, pruningFactor, escrowShouldClaimCbk, vaultShouldClaimCbk) {
        this.btcRelay = btcRelay;
        this.swapEvents = chainEvents;
        this.signer = signer;
        this.bitcoinRpc = bitcoinRpc;
        this.prunedTxoMap = new PrunedTxMap_1.PrunedTxMap(wtHeightStorageFile, bitcoinRpc, pruningFactor);
        this.EscrowSwaps = new EscrowSwaps_1.EscrowSwaps(this, storage, swapContract, escrowShouldClaimCbk);
        this.SpvVaultSwaps = new SpvVaultSwaps_1.SpvVaultSwaps(this, vaultStorage, spvVaultDataDeserializer, spvVaultContract, vaultShouldClaimCbk);
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.EscrowSwaps.init();
            yield this.SpvVaultSwaps.init();
            console.log("Watchtower: init(): Loaded!");
            //Sync to latest on Solana
            yield this.swapEvents.init();
            console.log("Watchtower: init(): Synchronized smart chain events");
            const resp = yield this.btcRelay.retrieveLatestKnownBlockLog();
            //Sync to previously processed block
            yield this.prunedTxoMap.init(resp.resultBitcoinHeader.height);
            //Get claim txs till the previously processed block
            const initialEscrowClaimTxs = yield this.EscrowSwaps.getClaimTxs();
            const initialSpvVaultClaimTxs = yield this.SpvVaultSwaps.getClaimTxs();
            console.log("Watchtower: init(): Returned escrow claim txs: ", initialEscrowClaimTxs);
            console.log("Watchtower: init(): Returned spv vault claim txs: ", initialEscrowClaimTxs);
            console.log("Watchtower: init(): Synced to last processed block");
            //Sync watchtower to the btc relay height and get all the claim txs
            const postSyncClaimTxs = yield this.syncToTipHash(resp.resultBitcoinHeader.hash);
            return Object.assign(Object.assign(Object.assign({}, initialEscrowClaimTxs), initialSpvVaultClaimTxs), postSyncClaimTxs);
        });
    }
    syncToTipHash(tipBlockHash, computedHeaderMap) {
        return __awaiter(this, void 0, void 0, function* () {
            console.log("[Watchtower.syncToTipHash]: Syncing to tip hash: ", tipBlockHash);
            //Check txoHashes that got required confirmations in these blocks,
            // but they might be already pruned if we only checked after
            const { foundTxos, foundTxins } = yield this.prunedTxoMap.syncToTipHash(tipBlockHash, this.EscrowSwaps.txoHashMap, this.SpvVaultSwaps.txinMap);
            console.log("Watchtower: syncToTipHash(): Returned found txins: ", foundTxins);
            const escrowClaimTxs = yield this.EscrowSwaps.getClaimTxs(foundTxos, computedHeaderMap);
            const spvVaultClaimTxs = yield this.SpvVaultSwaps.getClaimTxs(foundTxins, computedHeaderMap);
            console.log("Watchtower: syncToTipHash(): Returned escrow claim txs: ", escrowClaimTxs);
            console.log("Watchtower: syncToTipHash(): Returned spv vault claim txs: ", spvVaultClaimTxs);
            return Object.assign(Object.assign({}, escrowClaimTxs), spvVaultClaimTxs);
        });
    }
}
exports.Watchtower = Watchtower;

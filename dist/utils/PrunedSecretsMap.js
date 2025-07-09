"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrunedSecretsMap = void 0;
class PrunedSecretsMap {
    constructor(maxSize = 10000) {
        this.maxSize = maxSize;
        this.buffer = new Array(maxSize);
        this.nextIndex = 0;
        this.secretsMap = new Map();
    }
    set(escrowHash, secret) {
        const oldId = this.buffer[this.nextIndex];
        if (oldId !== undefined) {
            this.secretsMap.delete(oldId);
        }
        this.buffer[this.nextIndex] = escrowHash;
        this.secretsMap.set(escrowHash, secret);
        this.nextIndex = (this.nextIndex + 1) % this.maxSize;
    }
    get(escrowHash) {
        return this.secretsMap.get(escrowHash);
    }
}
exports.PrunedSecretsMap = PrunedSecretsMap;

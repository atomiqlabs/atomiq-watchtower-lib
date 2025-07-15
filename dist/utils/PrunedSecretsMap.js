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
        if (this.secretsMap.has(escrowHash))
            return false;
        const oldId = this.buffer[this.nextIndex];
        if (oldId !== undefined) {
            this.secretsMap.delete(oldId);
        }
        this.buffer[this.nextIndex] = escrowHash;
        this.secretsMap.set(escrowHash, secret);
        this.nextIndex = (this.nextIndex + 1) % this.maxSize;
        return true;
    }
    get(escrowHash) {
        return this.secretsMap.get(escrowHash);
    }
}
exports.PrunedSecretsMap = PrunedSecretsMap;

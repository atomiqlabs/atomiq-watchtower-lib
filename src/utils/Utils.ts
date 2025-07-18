
export function getLogger(prefix: string) {
    return {
        debug: (msg, ...args) => global.atomiqLogLevel >= 3 && console.debug(prefix+msg, ...args),
        info: (msg, ...args) => global.atomiqLogLevel >= 2 && console.info(prefix+msg, ...args),
        warn: (msg, ...args) => (global.atomiqLogLevel==null || global.atomiqLogLevel >= 1) && console.warn(prefix+msg, ...args),
        error: (msg, ...args) => (global.atomiqLogLevel==null || global.atomiqLogLevel >= 0) && console.error(prefix+msg, ...args)
    };
}

// Package market implements the deterministic shared exchange and private player
// ledgers. Prices and money are integer fen; quantities are shares. It never
// reads wall-clock time and does not authenticate users or authorize clock changes.
//
// Engine is owned by the server's serialized command loop. Callers must serialize
// operations, mutate a Clone, persist Export atomically, and only then publish the
// candidate. Snapshot and GetReview return detached public data. Restore validates
// an entire candidate without replacing any running engine.
package market

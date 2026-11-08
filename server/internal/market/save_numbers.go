package market

import (
	"math"
	"reflect"
)

const maxSafeInteger int64 = 1<<53 - 1

// Persisted integers also cross a JSON/JavaScript boundary. Validate leaves
// before doing arithmetic, then bound each variable-length sum and product.
func safePersistedNumbers(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		return v.IsNil() || safePersistedNumbers(v.Elem())
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if !safePersistedNumbers(v.Field(i)) {
				return false
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			if !safePersistedNumbers(v.Index(i)) {
				return false
			}
		}
	case reflect.Map:
		it := v.MapRange()
		for it.Next() {
			if !safePersistedNumbers(it.Value()) {
				return false
			}
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n := v.Int()
		return n >= -maxSafeInteger && n <= maxSafeInteger
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return v.Uint() <= uint64(maxSafeInteger)
	case reflect.Float32, reflect.Float64:
		return !math.IsNaN(v.Float()) && !math.IsInf(v.Float(), 0)
	}
	return true
}
func boundedSum(a, b, limit int64) (int64, bool) {
	if a < 0 || b < 0 || limit < 0 || limit > maxSafeInteger || a > limit || b > limit-a {
		return 0, false
	}
	return a + b, true
}
func safeProduct(a, b int64) (int64, bool) {
	if a < 0 || b < 0 || a > maxSafeInteger || b > maxSafeInteger || b != 0 && a > maxSafeInteger/b {
		return 0, false
	}
	return a * b, true
}

func safeSignedSum(a, b int64) (int64, bool) {
	if a < -maxSafeInteger || a > maxSafeInteger || b < -maxSafeInteger || b > maxSafeInteger || b > 0 && a > maxSafeInteger-b || b < 0 && a < -maxSafeInteger-b {
		return 0, false
	}
	return a + b, true
}

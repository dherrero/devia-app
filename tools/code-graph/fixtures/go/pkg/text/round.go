package text

func roundTo(v float64) float64 {
	return float64(int64(v*100)) / 100
}

package text

import (
	"fmt"
	"strings"
)

func Slugify(s string) string {
	return collapse(strings.ToLower(strings.TrimSpace(s)))
}

func collapse(s string) string {
	return strings.ReplaceAll(s, " ", "-")
}

func NormaliseEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func Money(cents int64) string {
	return fmt.Sprintf("%.2f EUR", roundTo(float64(cents)/100))
}

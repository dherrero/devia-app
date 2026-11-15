package vars

const Pi = 3.14

const (
	A, b = 1, 2
	C
)

var Global int

var (
	x, Y = 1, compute()
	z    = &Config{}
)

var _ = register()

func compute() int { return 1 }

// Package shapes holds shapes.
package shapes

// S is a struct.
// It runs.
type S struct {
	n int
	Name, Label string
	Base
	*Other
	pkg.Remote
	Stack[int]
	inner struct{ x int }
}

type Base struct{}

type Other struct{}

/* Runner runs. */
type Runner interface {
	Run() error
	Stop(force bool)
	io.Closer
	Walker
}

type ID int

type F func(int) string

type A = Base

type Stack[T any] struct {
	items []T
}

func (s *S) Run() error {
	helper()
	s.Stop(true)
	fmt.Println("x")
	return nil
}

func (s S) Stop(force bool) {}

func (st *Stack[T]) Push(v T) {
	st.items = append(st.items, v)
}

func (r *Remote) Ping() {}

// Exported is exported.
func Exported() {}

func internal() {}

func Build() *S {
	s := &S{n: 1}
	b := Base{}
	r := pkg.Remote{}
	p := &pkg.Remote{}
	st := Stack[int]{}
	go func() { worker() }()
	_ = b
	_, _, _ = r, p, st
	var local int
	const c = 1
	type localT struct{}
	return s
}

func helper() {}

func worker() {}

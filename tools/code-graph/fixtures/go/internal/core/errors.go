package core

type DomainError struct {
	Code string
	Msg  string
}

func (e *DomainError) Error() string {
	return e.Code + ": " + e.Msg
}

func NotFound(what string) error {
	return &DomainError{Code: "NOT_FOUND", Msg: describe(what)}
}

func describe(what string) string {
	return what + " not found"
}

func IsDomain(err error) bool {
	_, ok := err.(*DomainError)
	return ok
}

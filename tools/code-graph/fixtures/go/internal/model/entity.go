package model

// Identified is satisfied structurally by every entity.
type Identified interface {
	ID() string
}

type Keyed interface {
	Identified
	Key() string
}

type base struct {
	id string
}

func (b base) ID() string {
	return b.id
}

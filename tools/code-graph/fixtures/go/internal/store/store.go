package store

import (
	"example.com/shop/internal/core"
	"example.com/shop/internal/model"
)

type Store interface {
	Get(id string) (model.Identified, error)
	Save(item model.Identified)
}

type Memory struct {
	items map[string]model.Identified
}

func NewMemory() *Memory {
	return &Memory{items: map[string]model.Identified{}}
}

func (m *Memory) Get(id string) (model.Identified, error) {
	item, ok := m.items[id]
	if !ok {
		return nil, core.NotFound(id)
	}
	return item, nil
}

func (m *Memory) Save(item model.Identified) {
	m.items[item.ID()] = item
}

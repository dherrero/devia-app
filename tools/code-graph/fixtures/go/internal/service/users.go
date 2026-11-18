package service

import (
	"example.com/shop/internal/core"
	"example.com/shop/internal/model"
	"example.com/shop/internal/store"
	"example.com/shop/pkg/text"
)

type Users struct {
	store store.Store
	log   *core.Logger
}

func NewUsers(log *core.Logger) *Users {
	return &Users{store: store.NewMemory(), log: log}
}

func (s *Users) Register(name, email string) *model.User {
	u := model.NewUser(text.Slugify(name), name, email)
	s.store.Save(u)
	s.log.Info("registered " + u.ID())
	return u
}

func (s *Users) Find(id string) (*model.User, error) {
	item, err := s.store.Get(id)
	if err != nil {
		return nil, err
	}
	return item.(*model.User), nil
}

package service

import (
	"example.com/shop/internal/core"
	"example.com/shop/internal/model"
	st "example.com/shop/internal/store"
	"example.com/shop/pkg/text"
)

type Orders struct {
	users  *Users
	store  *st.Memory
	log    *core.Logger
	Events *core.Bus
}

func NewOrders(users *Users, log *core.Logger) *Orders {
	return &Orders{users: users, store: st.NewMemory(), log: log, Events: &core.Bus{}}
}

func (s *Orders) Open(id, userID string, lines []model.Line) (*model.Order, error) {
	owner, err := s.users.Find(userID)
	if err != nil {
		return nil, err
	}
	order := model.NewOrder(id, owner)
	for _, l := range lines {
		order.AddLine(l)
	}
	s.store.Save(order)
	s.Events.Publish("created " + id)
	return order, nil
}

func (s *Orders) Pay(id string) (string, error) {
	item, err := s.store.Get(id)
	if err != nil {
		return "", err
	}
	order := item.(*model.Order)
	order.MarkPaid()
	amount := text.Money(order.Total())
	s.log.Warn("paid " + amount)
	return amount, nil
}

package model

import "example.com/shop/pkg/text"

type User struct {
	base
	Name  string
	Email string
}

func NewUser(id, name, email string) *User {
	return &User{base: base{id: id}, Name: name, Email: text.NormaliseEmail(email)}
}

func (u *User) Key() string {
	return "user:" + u.ID()
}

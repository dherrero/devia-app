package api

import (
	"example.com/shop/internal/core"
	"example.com/shop/internal/service"
)

type Response struct {
	Status int
	Body   string
}

type Route func(args []string) Response

type Router struct {
	routes map[string]Route
}

func NewRouter(users *service.Users, orders *service.Orders) *Router {
	r := &Router{routes: map[string]Route{}}
	r.routes["register"] = func(args []string) Response {
		return ok(users.Register(args[0], args[1]).Name)
	}
	r.routes["pay"] = func(args []string) Response {
		amount, err := orders.Pay(args[0])
		return guard(amount, err)
	}
	return r
}

func (r *Router) Dispatch(command string, args []string) Response {
	route, found := r.routes[command]
	if !found {
		return notFound(command)
	}
	return route(args)
}

func guard(body string, err error) Response {
	if err != nil && core.IsDomain(err) {
		return notFound(err.Error())
	}
	return ok(body)
}

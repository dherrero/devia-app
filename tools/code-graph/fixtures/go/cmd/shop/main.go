package main

import (
	"os"

	"example.com/shop/internal/api"
	"example.com/shop/internal/core"
	"example.com/shop/internal/service"
	"example.com/shop/pkg/text"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	log := core.NewLogger("shop")
	users := service.NewUsers(log.Child("users"))
	orders := service.NewOrders(users, log.Child("orders"))
	orders.Events.Subscribe(func(p string) { log.Info(p) })
	router := api.NewRouter(users, orders)
	command := "help"
	if len(args) > 0 {
		command = text.Slugify(args[0])
	}
	return router.Dispatch(command, args).Status
}

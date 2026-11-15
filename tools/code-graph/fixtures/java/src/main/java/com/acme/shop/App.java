package com.acme.shop;

import com.acme.shop.api.Router;
import com.acme.shop.core.Logger;
import com.acme.shop.core.Format;
import com.acme.shop.service.OrderService;
import com.acme.shop.service.UserService;
import com.acme.shop.util.*;

public class App {
    public static void main(String[] args) {
        Logger log = new Logger("app");
        UserService users = new UserService(log.child("users"));
        OrderService orders = new OrderService(users, log.child("orders"));
        orders.events().subscribe(e -> log.info(e.kind + " " + e.orderId));
        Router router = new Router(users, orders);
        String command = args.length > 0 ? Strings.slugify(args[0]) : "help";
        log.info(Format.upper(command));
        System.exit(router.dispatch(command, args).getStatus() == 200 ? 0 : 1);
    }
}

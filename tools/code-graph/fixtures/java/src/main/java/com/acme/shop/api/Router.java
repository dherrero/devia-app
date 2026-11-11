package com.acme.shop.api;

import com.acme.shop.core.DomainException;
import com.acme.shop.service.OrderService;
import com.acme.shop.service.UserService;
import java.util.HashMap;
import java.util.Map;

public class Router {
    private final Map<String, Handler> routes = new HashMap<>();

    public Router(UserService users, OrderService orders) {
        routes.put("register", new RegisterHandler(users));
        routes.put("pay", args -> new Response(200, orders.pay(args[0])));
    }

    public Response dispatch(String command, String[] args) {
        Handler handler = routes.get(command);
        if (handler == null) {
            return new Response(404, command);
        }
        try {
            return handler.handle(args);
        } catch (DomainException e) {
            return new Response(404, e.getCode());
        }
    }

    private static final class RegisterHandler implements Handler {
        private final UserService users;

        RegisterHandler(UserService users) {
            this.users = users;
        }

        @Override
        public Response handle(String[] args) {
            if (args.length < 2) {
                return notFound("args");
            }
            return new Response(200, users.register(args[0], args[1]).getName());
        }
    }
}

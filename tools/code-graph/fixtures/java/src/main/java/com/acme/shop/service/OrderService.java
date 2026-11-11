package com.acme.shop.service;

import com.acme.shop.core.EventBus;
import com.acme.shop.core.Logger;
import com.acme.shop.model.Order;
import com.acme.shop.model.User;
import com.acme.shop.util.Money;
import java.util.List;

public class OrderService {
    public static final class OrderEvent {
        public final String orderId;
        public final String kind;

        OrderEvent(String orderId, String kind) {
            this.orderId = orderId;
            this.kind = kind;
        }
    }

    private final EventBus<OrderEvent> events = new EventBus<>();
    private final InMemoryRepository<Order> repo = new InMemoryRepository<>();
    private final UserService users;
    private final Logger log;

    public OrderService(UserService users, Logger log) {
        this.users = users;
        this.log = log;
    }

    public EventBus<OrderEvent> events() {
        return events;
    }

    public Order open(String orderId, String userId, List<Order.Line> lines) {
        User owner = users.find(userId);
        Order order = new Order(orderId, owner);
        for (Order.Line line : lines) {
            order.addLine(line);
        }
        repo.save(order);
        events.publish(new OrderEvent(orderId, "created"));
        return order;
    }

    public String pay(String orderId) {
        Order order = this.repo.get(orderId);
        order.markPaid();
        String amount = Money.format(order.total());
        this.log.warn("paid " + amount);
        return amount;
    }
}

package com.acme.shop.model;

import java.util.ArrayList;
import java.util.List;

public class Order extends Entity {
    public enum Status { OPEN, PAID, SHIPPED }

    public static class Line {
        private final String sku;
        private final int quantity;
        private final long unitPrice;

        public Line(String sku, int quantity, long unitPrice) {
            this.sku = sku;
            this.quantity = quantity;
            this.unitPrice = unitPrice;
        }

        public long total() {
            return quantity * unitPrice;
        }

        public String getSku() {
            return sku;
        }
    }

    private final User owner;
    private final List<Line> lines = new ArrayList<>();
    private Status status = Status.OPEN;

    public Order(String id, User owner) {
        super(id);
        this.owner = owner;
    }

    public void addLine(Line line) {
        lines.add(line);
    }

    public long total() {
        long sum = 0;
        for (Line l : lines) {
            sum += l.total();
        }
        return sum;
    }

    public void markPaid() {
        status = Status.PAID;
    }

    public User getOwner() {
        return owner;
    }

    @Override
    protected String kind() {
        return "order";
    }
}

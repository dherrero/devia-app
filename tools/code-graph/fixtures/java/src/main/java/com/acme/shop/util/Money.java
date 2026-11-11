package com.acme.shop.util;

public final class Money {
    private Money() {}

    public static String format(long cents) {
        return roundTo(cents / 100.0, 2) + " EUR";
    }

    static double roundTo(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }
}

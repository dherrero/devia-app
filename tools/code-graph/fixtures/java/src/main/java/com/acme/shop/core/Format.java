package com.acme.shop.core;

public final class Format {
    private Format() {}

    public static String line(String scope, String message) {
        return "[" + scope + "] " + message;
    }

    public static String upper(String value) {
        return value.toUpperCase();
    }
}

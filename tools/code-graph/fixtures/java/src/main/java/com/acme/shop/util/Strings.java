package com.acme.shop.util;

public final class Strings {
    private Strings() {}

    public static String slugify(String input) {
        return collapseDashes(input.toLowerCase().replaceAll("[^a-z0-9]+", "-"));
    }

    public static String collapseDashes(String input) {
        return input.replaceAll("-+", "-");
    }

    public static String normaliseEmail(String email) {
        return email.trim().toLowerCase();
    }
}

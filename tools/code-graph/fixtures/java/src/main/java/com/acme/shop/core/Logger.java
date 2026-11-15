package com.acme.shop.core;

public class Logger {
    private final String scope;

    public Logger(String scope) {
        this.scope = scope;
    }

    public void info(String message) {
        write("INFO", message);
    }

    public void warn(String message) {
        write("WARN", message);
    }

    public Logger child(String name) {
        return new Logger(scope + ":" + name);
    }

    private void write(String level, String message) {
        System.out.println(Format.line(scope, level + " " + message));
    }
}

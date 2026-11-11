package com.acme.shop.core;

public class NotFoundException extends DomainException {
    public NotFoundException(String what) {
        super(describe(what), "NOT_FOUND");
    }

    static String describe(String what) {
        return what + " not found";
    }
}

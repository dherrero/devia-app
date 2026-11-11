package com.acme.shop.api;

public interface Handler {
    Response handle(String[] args);

    default Response notFound(String what) {
        return new Response(404, what);
    }
}

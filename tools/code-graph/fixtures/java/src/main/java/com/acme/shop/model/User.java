package com.acme.shop.model;

import com.acme.shop.util.Strings;

public class User extends Entity {
    private final String name;
    private final String email;

    public User(String id, String name, String email) {
        super(id);
        this.name = name;
        this.email = Strings.normaliseEmail(email);
    }

    public String getName() {
        return name;
    }

    public String getEmail() {
        return email;
    }

    @Override
    protected String kind() {
        return "user";
    }
}

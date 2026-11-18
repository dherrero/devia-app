package com.acme.shop.model;

public abstract class Entity implements Identified {
    protected final String id;

    protected Entity(String id) {
        this.id = id;
    }

    @Override
    public String getId() {
        return id;
    }

    public String key() {
        return kind() + ":" + getId();
    }

    protected abstract String kind();
}

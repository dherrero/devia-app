package com.acme.shop.service;

import com.acme.shop.core.NotFoundException;
import com.acme.shop.model.Identified;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class InMemoryRepository<T extends Identified> implements Repository<T> {
    private final Map<String, T> items = new HashMap<>();

    @Override
    public T get(String id) {
        T found = items.get(id);
        if (found == null) {
            throw new NotFoundException(id);
        }
        return found;
    }

    @Override
    public void save(T item) {
        items.put(item.getId(), item);
    }

    @Override
    public List<T> all() {
        return new ArrayList<>(items.values());
    }
}

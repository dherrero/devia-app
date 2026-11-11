package com.acme.shop.service;

import com.acme.shop.model.Identified;
import java.util.List;

public interface Repository<T extends Identified> {
    T get(String id);

    void save(T item);

    List<T> all();
}

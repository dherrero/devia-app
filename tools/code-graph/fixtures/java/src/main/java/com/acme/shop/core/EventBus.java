package com.acme.shop.core;

import java.util.ArrayList;
import java.util.List;

public class EventBus<T> {
    public interface Listener<E> {
        void onEvent(E event);
    }

    private final List<Listener<T>> listeners = new ArrayList<>();

    public void subscribe(Listener<T> listener) {
        listeners.add(listener);
    }

    public void publish(T event) {
        for (Listener<T> l : listeners) {
            l.onEvent(event);
        }
    }

    public int size() {
        return listeners.size();
    }
}

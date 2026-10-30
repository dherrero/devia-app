import { TestBed } from '@angular/core/testing';
import { KanbanColumnComponent } from './component';
import { DragDropModule } from '@angular/cdk/drag-drop';

describe('KanbanColumnComponent', () => {
  it('creates', async () => {
    await TestBed.configureTestingModule({
      imports: [KanbanColumnComponent, DragDropModule],
    }).compileComponents();
    const fixture = TestBed.createComponent(KanbanColumnComponent);
    fixture.componentRef.setInput('column', {
      id: 'col1',
      title: 'Todo',
      items: [],
    });
    fixture.detectChanges();
    expect(fixture.componentInstance).toBeTruthy();
  });
});

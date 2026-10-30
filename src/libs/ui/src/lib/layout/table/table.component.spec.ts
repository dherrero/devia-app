import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TableComponent } from './table.component';
import { TableColumnDef } from './table.models';
import { By } from '@angular/platform-browser';
import { Component } from '@angular/core';

@Component({
  standalone: true,
  imports: [TableComponent],
  template: `
    <dv-table
      [columns]="columns"
      [data]="data"
      [loading]="loading"
      [emptyText]="emptyText"
      [density]="density"
      [clickable]="true"
      (rowClick)="onRowClick($event)"
    />
  `,
})
class HostWithRowClick {
  columns: TableColumnDef[] = [];
  data: unknown[] = [];
  loading = false;
  emptyText = 'No hay datos';
  density: 'compact' | 'comfortable' = 'comfortable';
  lastClicked: unknown = null;
  onRowClick(row: unknown) {
    this.lastClicked = row;
  }
}

@Component({
  standalone: true,
  imports: [TableComponent],
  template: `
    <dv-table
      [columns]="columns"
      [data]="data"
      [loading]="loading"
      [emptyText]="emptyText"
      [density]="density"
    />
  `,
})
class HostNoRowClick {
  columns: TableColumnDef[] = [];
  data: unknown[] = [];
  loading = false;
  emptyText = 'No hay datos';
  density: 'compact' | 'comfortable' = 'comfortable';
}

describe('TableComponent', () => {
  const columns: TableColumnDef[] = [
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status' },
  ];

  const data = [
    { name: 'Alice', status: 'Active' },
    { name: 'Bob', status: 'Inactive' },
  ];

  describe('standalone', () => {
    let fixture: ComponentFixture<TableComponent>;
    let component: TableComponent;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [TableComponent],
      }).compileComponents();

      fixture = TestBed.createComponent(TableComponent);
      component = fixture.componentInstance;
    });

    it('should create', () => {
      expect(component).toBeTruthy();
    });

    it('should render column headers', () => {
      fixture.componentRef.setInput('columns', columns);
      fixture.detectChanges();

      const headers = fixture.debugElement.queryAll(
        By.css('.dv-table__cell--header'),
      );
      expect(headers.length).toBe(2);
      expect(headers[0].nativeElement.textContent.trim()).toBe('Name');
      expect(headers[1].nativeElement.textContent.trim()).toBe('Status');
    });

    it('should render data rows', () => {
      fixture.componentRef.setInput('columns', columns);
      fixture.componentRef.setInput('data', data);
      fixture.detectChanges();

      const rows = fixture.debugElement.queryAll(
        By.css('.dv-table__row--data'),
      );
      expect(rows.length).toBe(2);
    });

    it('should show loading skeleton rows when loading=true', () => {
      fixture.componentRef.setInput('columns', columns);
      fixture.componentRef.setInput('loading', true);
      fixture.detectChanges();

      const skeletonRows = fixture.debugElement.queryAll(
        By.css('.dv-table__row--skeleton'),
      );
      expect(skeletonRows.length).toBe(3);
    });

    it('should not show data rows when loading=true', () => {
      fixture.componentRef.setInput('columns', columns);
      fixture.componentRef.setInput('data', data);
      fixture.componentRef.setInput('loading', true);
      fixture.detectChanges();

      const dataRows = fixture.debugElement.queryAll(
        By.css('.dv-table__row--data'),
      );
      expect(dataRows.length).toBe(0);
    });

    it('should show empty state when data is empty and not loading', () => {
      fixture.componentRef.setInput('columns', columns);
      fixture.componentRef.setInput('data', []);
      fixture.componentRef.setInput('emptyText', 'Nothing here');
      fixture.detectChanges();

      const emptyRow = fixture.debugElement.query(
        By.css('.dv-table__row--empty'),
      );
      expect(emptyRow).toBeTruthy();
      const emptyState = fixture.debugElement.query(By.css('dv-empty-state'));
      expect(emptyState).toBeTruthy();
    });

    it('should apply comfortable density class by default', () => {
      fixture.componentRef.setInput('columns', columns);
      fixture.detectChanges();

      const table = fixture.debugElement.query(By.css('table'));
      expect(
        table.nativeElement.classList.contains('dv-table--comfortable'),
      ).toBe(true);
    });

    it('should apply compact density class when set', () => {
      fixture.componentRef.setInput('columns', columns);
      fixture.componentRef.setInput('density', 'compact');
      fixture.detectChanges();

      const table = fixture.debugElement.query(By.css('table'));
      expect(table.nativeElement.classList.contains('dv-table--compact')).toBe(
        true,
      );
    });
  });

  describe('with rowClick listener (via host component)', () => {
    let fixture: ComponentFixture<HostWithRowClick>;
    let host: HostWithRowClick;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [HostWithRowClick],
      }).compileComponents();

      fixture = TestBed.createComponent(HostWithRowClick);
      host = fixture.componentInstance;
      host.columns = columns;
      host.data = data;
      fixture.detectChanges();
    });

    it('should emit rowClick when a data row is clicked', () => {
      const rows = fixture.debugElement.queryAll(
        By.css('.dv-table__row--data'),
      );
      rows[0].nativeElement.click();
      fixture.detectChanges();

      expect(host.lastClicked).toEqual(data[0]);
    });

    it('should emit rowClick on Enter key', () => {
      const row = fixture.debugElement.query(By.css('.dv-table__row--data'));
      row.triggerEventHandler(
        'keydown',
        new KeyboardEvent('keydown', { key: 'Enter' }),
      );
      fixture.detectChanges();

      expect(host.lastClicked).toEqual(data[0]);
    });

    it('should emit rowClick on Space key', () => {
      const row = fixture.debugElement.query(By.css('.dv-table__row--data'));
      row.triggerEventHandler(
        'keydown',
        new KeyboardEvent('keydown', { key: ' ' }),
      );
      fixture.detectChanges();

      expect(host.lastClicked).toEqual(data[0]);
    });

    it('should set tabindex=0 and role=button on rows when rowClick is bound', () => {
      const row = fixture.debugElement.query(By.css('.dv-table__row--data'));
      expect(row.nativeElement.getAttribute('tabindex')).toBe('0');
      expect(row.nativeElement.getAttribute('role')).toBe('button');
    });
  });

  describe('without rowClick listener', () => {
    let fixture: ComponentFixture<HostNoRowClick>;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [HostNoRowClick],
      }).compileComponents();

      fixture = TestBed.createComponent(HostNoRowClick);
      fixture.componentInstance.columns = columns;
      fixture.componentInstance.data = data;
      fixture.detectChanges();
    });

    it('should not set tabindex or role on rows when rowClick is not bound', () => {
      const row = fixture.debugElement.query(By.css('.dv-table__row--data'));
      expect(row.nativeElement.getAttribute('tabindex')).toBeNull();
      expect(row.nativeElement.getAttribute('role')).toBeNull();
    });
  });
});

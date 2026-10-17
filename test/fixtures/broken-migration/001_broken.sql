CREATE TABLE should_be_rolled_back (id integer PRIMARY KEY);
SELECT * FROM deliberately_missing_table;
